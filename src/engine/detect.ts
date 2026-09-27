// The analysis pipeline: TextBlocks -> per-sentence 0..1 AI likelihoods for
// each detector mode, given already-loaded models. Model loading, caching
// and messaging live elsewhere (./engine.ts); this file only needs a
// `LoadedModel` per slot, so the Node calibration/smoke scripts can drive it
// directly.

import type { Tensor } from "@huggingface/transformers";
import type { AnalyzeResult, DetectorRun, ProgressEvent, ScoreSource, SentenceScore, TextBlock } from "../shared/messages";
import type { EnsembleClassifier, FusionDetector, FusionSettings, Mode, ModelSlot } from "../shared/settings";
import { FLAGGED_THRESHOLD, MIN_WORDS_FOR_SCORE, toDisplayProbability } from "../shared/thresholds";
import type { LoadedClassifier, LoadedLM, LoadedModel } from "./loader";
import { calibrationFor, type ClassifierSlot } from "./calibration";
import { DEFAULT_MODELS, DETECTOR_LABELS, DETECTOR_SLOTS, detectorsForMode, type FusionSpec } from "./models";
import {
  agreementOf,
  binocularsProbability,
  binocularsScore,
  burstiness,
  clamp01,
  finiteMean,
  fuseScores,
  perSentenceMean,
  perplexityProbability,
  planWindows,
  recalibrateClassifier,
  sequenceBinoculars,
  sequenceNLL,
  softmax,
  spanMean,
  weightedMean,
} from "./scoring";
import {
  blockStarts,
  buildDoc,
  buildUnits,
  capSentences,
  packChunks,
  sentencePieces,
  type Doc,
  type Span,
} from "./text";

/** Preferred classifier chunk size: long enough to be reliable, short enough to localise. */
export const CLASSIFIER_TARGET_TOKENS = 384;

export interface AnalysisOptions {
  mode: Mode;
  minWords: number;
  maxTokens: number;
  /** Legacy: classifier the v1 ensemble used. Ignored when `fusion` is set. */
  ensembleClassifier?: EnsembleClassifier;
  /** Fusion detector set and method (mode "ensemble"). Default: DEFAULT_FUSION. */
  fusion?: FusionSettings;
}

/** Raw statistics, for calibration and debugging. */
export interface AnalysisStats {
  words: number;
  sentences: number;
  analysedSentences: number;
  tokens: number;
  classifier?: number;
  /** Classifier probability before recalibration (the first classifier run). */
  classifierRaw?: number;
  /** Raw P(ai) per classifier detector, and each detector's overall score. */
  raw?: Partial<Record<FusionDetector, number>>;
  overallBy?: Partial<Record<FusionDetector, number>>;
  logPPL?: number;
  burstiness?: number;
  binoculars?: number;
}

export interface Analysis {
  result: Omit<AnalyzeResult, "unicode">;
  stats: AnalysisStats;
}

type Models = Partial<Record<ModelSlot, LoadedModel>>;
type AnalyzeProgress = (p: ProgressEvent) => void;

function tokenizePieces(model: LoadedModel, pieces: string[]): number[][] {
  return pieces.map((p) => model.tokenizer.encode(p, { add_special_tokens: false }) as number[]);
}

interface Counter {
  done: number;
  total: number;
  tick(message: string): void;
}

function makeCounter(total: number, onProgress?: AnalyzeProgress): Counter {
  const c: Counter = {
    done: 0,
    total,
    tick(message: string) {
      c.done++;
      onProgress?.({ phase: "analyze", loaded: Math.min(c.done, c.total), total: c.total, message });
    },
  };
  return c;
}

// ---------------- per-detector runners ----------------

interface ClassifierOut {
  perSentence: Float64Array;
  overall: number;
  rawOverall: number;
}

async function runClassifier(
  slot: ClassifierSlot,
  m: LoadedClassifier,
  doc: Doc,
  n: number,
  counter: Counter,
  docChunks: Span[],
  sentenceChunks: Span[],
): Promise<ClassifierOut> {
  const perSentence = new Float64Array(n).fill(Number.NaN);
  // Recalibrate only the pinned default repo; a custom model has its own scale.
  const isDefault = m.ref.repo === DEFAULT_MODELS[slot].repo;
  const cal = calibrationFor(m.device);
  const docCal = isDefault ? cal.classifier[slot] : undefined;
  const unitCal = isDefault ? cal.unit.classifier[slot] : undefined;
  // Raw P(ai) per chunk, memoised: the overall score and the sentence colours
  // use different packings (see analyzeBlocks) that often share chunks.
  const memo = new Map<string, { raw: number; tokens: number }>();
  const rawOf = async (ch: Span) => {
    const key = `${ch.first}-${ch.last}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const text = doc.text.slice(doc.sentences[ch.first]!.start, doc.sentences[ch.last]!.end);
    const enc = m.tokenizer(text, { truncation: true, max_length: m.maxLength }) as unknown as Record<string, Tensor>;
    const out = (await (m.model as unknown as (x: unknown) => Promise<{ logits: Tensor }>)(enc)).logits;
    const logits = out.type === "float32" ? out : out.to("float32");
    const probs = softmax(logits.data as Float32Array);
    const r = { raw: probs[m.aiIndex] ?? Number.NaN, tokens: Number(enc.input_ids?.dims?.[1] ?? 1) };
    memo.set(key, r);
    counter.tick("Running classifier");
    return r;
  };
  // Sentence colours: one chunk per paragraph, mapped with the paragraph-level calibration.
  for (const ch of sentenceChunks) {
    const p = recalibrateClassifier((await rawOf(ch)).raw, unitCal);
    for (let i = ch.first; i <= ch.last; i++) perSentence[i] = p;
  }
  // Overall: document-sized chunks, mapped with the document-level calibration.
  const chunkP: number[] = [];
  const chunkRaw: number[] = [];
  const chunkW: number[] = [];
  for (const ch of docChunks) {
    const { raw, tokens } = await rawOf(ch);
    chunkP.push(recalibrateClassifier(raw, docCal));
    chunkRaw.push(raw);
    chunkW.push(tokens);
  }
  return { perSentence, overall: weightedMean(chunkP, chunkW), rawOverall: weightedMean(chunkRaw, chunkW) };
}

function lmSequence(m: LoadedLM, pieceIds: number[][]): { seq: number[]; tokenSentence: Int32Array } {
  const prefix = m.bos !== null ? [m.bos] : [];
  const total = prefix.length + pieceIds.reduce((a, p) => a + p.length, 0);
  const seq: number[] = new Array(total);
  const tokenSentence = new Int32Array(total).fill(-1);
  let j = 0;
  for (const t of prefix) seq[j++] = t;
  pieceIds.forEach((ids, s) => {
    for (const t of ids) {
      tokenSentence[j] = s;
      seq[j++] = t;
    }
  });
  return { seq, tokenSentence };
}

interface ProbOut {
  perSentence: Float64Array;
  overall: number;
  stat: number;
  burst?: number;
}

async function runPerplexity(m: LoadedLM, pieceIds: number[][], units: Span[], counter: Counter): Promise<ProbOut> {
  const n = pieceIds.length;
  const { seq, tokenSentence } = lmSequence(m, pieceIds);
  const nll = await sequenceNLL(m.forward, seq, m.window, m.overlap, () => counter.tick("Measuring perplexity"));
  const { mean, count } = perSentenceMean(nll, tokenSentence, n);
  const burst = burstiness(mean, count);
  const cal = calibrationFor(m.device);
  const pcal = cal.perplexity;
  // Per-unit (paragraph-sized) log-PPL is noisier than a whole document's,
  // so units get their own threshold (docs/calibration.md).
  const ucal = { ...pcal, tau: cal.unit.perplexityTau, a: cal.unit.perplexityA ?? pcal.a };
  const perSentence = new Float64Array(n).fill(Number.NaN);
  for (const u of units) {
    const p = perplexityProbability(spanMean(mean, count, u.first, u.last), burst, ucal);
    for (let i = u.first; i <= u.last; i++) perSentence[i] = p;
  }
  const docLogPPL = finiteMean(nll);
  return { perSentence, overall: perplexityProbability(docLogPPL, burst, pcal), stat: docLogPPL, burst };
}

async function runBinoculars(
  obs: LoadedLM,
  perf: LoadedLM,
  pieceIds: number[][],
  units: Span[],
  counter: Counter,
): Promise<ProbOut> {
  const n = pieceIds.length;
  const { seq, tokenSentence } = lmSequence(obs, pieceIds);
  const window = Math.min(obs.window, perf.window);
  const overlap = Math.min(obs.overlap, perf.overlap);
  const { nll, xent } = await sequenceBinoculars(obs.forward, perf.forward, seq, window, overlap, () =>
    counter.tick("Running Binoculars"),
  );
  const a = perSentenceMean(nll, tokenSentence, n);
  const b = perSentenceMean(xent, tokenSentence, n);
  const cal = calibrationFor(perf.device);
  const ucal = { tau: cal.unit.binocularsTau, k: cal.unit.binocularsK ?? cal.binoculars.k };
  const perSentence = new Float64Array(n).fill(Number.NaN);
  for (const u of units) {
    const s = binocularsScore(spanMean(a.mean, a.count, u.first, u.last), spanMean(b.mean, b.count, u.first, u.last));
    const p = binocularsProbability(s, ucal);
    for (let i = u.first; i <= u.last; i++) perSentence[i] = p;
  }
  const score = binocularsScore(finiteMean(nll), finiteMean(xent));
  return { perSentence, overall: binocularsProbability(score, cal.binoculars), stat: score };
}

// ---------------- orchestration ----------------

function need<T extends LoadedModel["kind"]>(
  models: Models,
  slot: ModelSlot,
  kind: T,
): Extract<LoadedModel, { kind: T }> {
  const m = models[slot];
  if (!m || m.kind !== kind) throw new Error(`Model for slot "${slot}" is not loaded`);
  return m as Extract<LoadedModel, { kind: T }>;
}

/** Runs the detector(s) for `opts.mode` over `blocks` with already-loaded `models`. */
export async function analyzeBlocks(
  blocks: TextBlock[],
  opts: AnalysisOptions,
  models: Models,
  onProgress?: AnalyzeProgress,
): Promise<Analysis> {
  const doc = buildDoc(blocks);
  const notes: string[] = [];
  const totalWords = doc.sentences.reduce((a, s) => a + s.words, 0);
  const stats: AnalysisStats = {
    words: totalWords,
    sentences: doc.sentences.length,
    analysedSentences: 0,
    tokens: 0,
  };
  if (doc.sentences.length === 0) {
    notes.push("No text to analyse.");
    return { result: { overall: 0, sentences: [], notes }, stats };
  }

  const spec: FusionSpec = opts.fusion ?? opts.ensembleClassifier;
  const { detectors, method } = detectorsForMode(opts.mode, spec);
  const firstSlot = DETECTOR_SLOTS[detectors[0]!]![0]!;
  const primary = models[firstSlot];
  if (!primary) throw new Error(`Model for slot "${firstSlot}" is not loaded`);

  // 1. Cap the text at maxTokens (measured with the first model's tokenizer).
  const allPieces = sentencePieces(doc);
  const primaryIds = tokenizePieces(primary, allPieces);
  const n = capSentences(
    primaryIds.map((ids) => ids.length),
    Math.max(16, opts.maxTokens),
  );
  const tooLong = n < doc.sentences.length;
  const pieces = allPieces.slice(0, n);
  const sentences = doc.sentences.slice(0, n);
  const words = sentences.map((s) => s.words);
  const analysedWords = words.reduce((a, b) => a + b, 0);
  stats.analysedSentences = n;
  stats.tokens = primaryIds.slice(0, n).reduce((a, ids) => a + ids.length, 0);
  if (tooLong) {
    notes.push(
      `Only the first ~${opts.maxTokens} tokens were analysed (${n} of ${doc.sentences.length} sentences). Raise "max tokens" in settings to analyse more.`,
    );
  }

  // 2. Scoring units: groups of >= minWords words, so short sentences are
  //    folded into their neighbours instead of getting their own verdict.
  const starts = blockStarts(sentences);
  const units = buildUnits(words, opts.minWords, starts);
  if (analysedWords < opts.minWords) {
    notes.push(
      `Only ${analysedWords} words: below the ${opts.minWords}-word minimum, so this score is low-confidence.`,
    );
  } else if (detectors.some((d) => d === "perplexity" || d === "binoculars")) {
    notes.push(`Sentence colours are scored in groups of at least ${opts.minWords} words.`);
  }

  // 3. Plan the work so progress has a real denominator.
  const idsFor = (m: LoadedModel) => (m === primary ? primaryIds.slice(0, n) : tokenizePieces(m, pieces));
  const plan: Array<() => Promise<void>> = [];
  let total = 0;
  const outs = new Map<FusionDetector, { perSentence: Float64Array; overall: number; device: string; dtype: string }>();
  const counterRef: { c?: Counter } = {};
  const CLS_SLOT: Partial<Record<FusionDetector, ClassifierSlot>> = {
    fakespot: "classifierFakespot",
    tmr: "classifier",
    lite: "classifierLite",
    modernbert: "classifierModernBert",
  };

  for (const det of detectors) {
    const cslot = CLS_SLOT[det];
    if (cslot) {
      const m = need(models, cslot, "classifier");
      const counts = idsFor(m).map((ids) => ids.length);
      // Overall: document-sized chunks (what the calibration was fitted on).
      const docChunks = packChunks(units, counts, m.maxLength - 2, CLASSIFIER_TARGET_TOKENS, starts);
      // Sentence colours: never mix paragraphs (different paragraphs are often
      // different authors: comments, quotes, pasted AI text).
      const sentenceChunks = packChunks(units, counts, m.maxLength - 2, CLASSIFIER_TARGET_TOKENS, starts, true);
      const keys = new Set([...docChunks, ...sentenceChunks].map((c) => `${c.first}-${c.last}`));
      total += keys.size;
      plan.push(async () => {
        const r = await runClassifier(cslot, m, doc, n, counterRef.c!, docChunks, sentenceChunks);
        outs.set(det, { perSentence: r.perSentence, overall: r.overall, device: m.device, dtype: m.dtype });
        (stats.raw ??= {})[det] = r.rawOverall;
        if (stats.classifierRaw === undefined) {
          stats.classifier = r.overall;
          stats.classifierRaw = r.rawOverall;
        }
      });
    } else if (det === "perplexity") {
      const m = need(models, "perplexityLM", "lm");
      const ids = idsFor(m);
      const len = (m.bos !== null ? 1 : 0) + ids.reduce((a, x) => a + x.length, 0);
      total += planWindows(len, m.window, m.overlap).length;
      plan.push(async () => {
        const r = await runPerplexity(m, ids, units, counterRef.c!);
        outs.set(det, { perSentence: r.perSentence, overall: r.overall, device: m.device, dtype: m.dtype });
        stats.logPPL = r.stat;
        stats.burstiness = r.burst;
      });
    } else if (det === "binoculars") {
      const obs = need(models, "binocularsObserver", "lm");
      const perf = need(models, "binocularsPerformer", "lm");
      const ids = idsFor(obs);
      // Both models must tokenize identically (Binoculars compares their
      // distributions token by token).
      const probe = pieces.slice(0, 3).join("");
      const a = obs.tokenizer.encode(probe, { add_special_tokens: false }) as number[];
      const b = perf.tokenizer.encode(probe, { add_special_tokens: false }) as number[];
      if (a.length !== b.length || a.some((t, i) => t !== b[i])) {
        throw new Error("Binoculars observer and performer use different tokenizers; pick a matching pair.");
      }
      const len = (obs.bos !== null ? 1 : 0) + ids.reduce((acc, x) => acc + x.length, 0);
      total += planWindows(len, Math.min(obs.window, perf.window), Math.min(obs.overlap, perf.overlap)).length;
      plan.push(async () => {
        const r = await runBinoculars(obs, perf, ids, units, counterRef.c!);
        outs.set(det, { perSentence: r.perSentence, overall: r.overall, device: perf.device, dtype: perf.dtype });
        stats.binoculars = r.stat;
      });
      notes.push("Binoculars with 135M-parameter models is experimental.");
    }
  }

  counterRef.c = makeCounter(Math.max(1, total), onProgress);
  onProgress?.({ phase: "analyze", loaded: 0, total: counterRef.c.total, message: "Analysing text" });
  for (const step of plan) await step();

  // 4. Combine into per-sentence scores.
  const cal = calibrationFor(outs.get(detectors[0]!)?.device);
  const weightOf = (d: FusionDetector) => (method === "weighted" ? cal.fusionWeights[d] : 1);
  const multi = detectors.length > 1;
  const SOURCE_OF: Record<FusionDetector, ScoreSource> = {
    fakespot: "classifier",
    tmr: "classifier",
    lite: "classifier",
    modernbert: "classifier",
    perplexity: "perplexity",
    binoculars: "binoculars",
  };
  const out: SentenceScore[] = [];
  for (let i = 0; i < n; i++) {
    const sources: Partial<Record<ScoreSource, number>> = {};
    const per: Partial<Record<FusionDetector, number>> = {};
    const scores: { p: number; weight: number }[] = [];
    for (const d of detectors) {
      const p = outs.get(d)?.perSentence[i] ?? Number.NaN;
      if (!Number.isFinite(p)) continue;
      per[d] = p;
      // Legacy `sources`: the first classifier, perplexity, binoculars.
      if (sources[SOURCE_OF[d]] === undefined) sources[SOURCE_OF[d]] = p;
      scores.push({ p, weight: weightOf(d) });
    }
    const score = fuseScores(scores, method);
    const s: SentenceScore = { blockId: sentences[i]!.blockId, index: sentences[i]!.index, score: clamp01(score), sources };
    if (multi) {
      s.detectors = per;
      s.agreement = agreementOf(scores.map((x) => x.p), score, FLAGGED_THRESHOLD);
    }
    out.push(s);
  }

  const overallScores = detectors.map((d) => ({ p: outs.get(d)?.overall ?? Number.NaN, weight: weightOf(d) }));
  const overall = fuseScores(overallScores, method);
  stats.overallBy = Object.fromEntries(detectors.map((d) => [d, outs.get(d)?.overall ?? Number.NaN]));

  const runs: DetectorRun[] = detectors.map((d) => {
    const o = outs.get(d);
    const dev = o?.device === "webgpu" ? "webgpu" : o?.device === "cpu" ? "cpu" : "wasm";
    return { id: d, label: DETECTOR_LABELS[d], overall: clamp01(o?.overall ?? Number.NaN), device: dev, dtype: o?.dtype ?? "", weight: weightOf(d) };
  });
  const devices = new Set(runs.map((r) => r.device));
  const device = devices.size === 1 ? [...devices][0]! : "mixed";

  const result: Analysis["result"] = { overall: clamp01(overall), sentences: out, notes, words: analysedWords, detectors: runs, device };
  if (multi) {
    result.fusion = { method, agreement: agreementOf(overallScores.map((x) => x.p), overall, FLAGGED_THRESHOLD) };
  }
  if (analysedWords >= MIN_WORDS_FOR_SCORE && Number.isFinite(overall)) {
    result.probability = toDisplayProbability(result.overall, { detectors, method, device, words: analysedWords });
  }
  if (tooLong) result.tooLong = true;
  return { result, stats };
}
