// The analysis pipeline: TextBlocks -> per-sentence 0..1 AI likelihoods for
// each detector mode, given already-loaded models. Model loading, caching
// and messaging live elsewhere (./engine.ts); this file only needs a
// `LoadedModel` per slot, so the Node calibration/smoke scripts can drive it
// directly.

import type { Tensor } from "@huggingface/transformers";
import type { AnalyzeResult, ProgressEvent, ScoreSource, SentenceScore, TextBlock } from "../shared/messages";
import type { Mode, ModelSlot } from "../shared/settings";
import type { LoadedClassifier, LoadedLM, LoadedModel } from "./loader";
import { slotsForMode } from "./models";
import {
  binocularsProbability,
  binocularsScore,
  blendEnsemble,
  burstiness,
  clamp01,
  finiteMean,
  perSentenceMean,
  perplexityProbability,
  planWindows,
  sequenceBinoculars,
  sequenceNLL,
  softmax,
  spanMean,
  weightedMean,
} from "./scoring";
import {
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
}

/** Raw statistics, for calibration and debugging. */
export interface AnalysisStats {
  words: number;
  sentences: number;
  analysedSentences: number;
  tokens: number;
  classifier?: number;
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
}

async function runClassifier(
  m: LoadedClassifier,
  doc: Doc,
  n: number,
  counter: Counter,
  chunks: Span[],
): Promise<ClassifierOut> {
  const perSentence = new Float64Array(n).fill(Number.NaN);
  const chunkP: number[] = [];
  const chunkW: number[] = [];
  for (const ch of chunks) {
    const text = doc.text.slice(doc.sentences[ch.first]!.start, doc.sentences[ch.last]!.end);
    const enc = m.tokenizer(text, { truncation: true, max_length: m.maxLength }) as unknown as Record<string, Tensor>;
    const out = (await (m.model as unknown as (x: unknown) => Promise<{ logits: Tensor }>)(enc)).logits;
    const logits = out.type === "float32" ? out : out.to("float32");
    const probs = softmax(logits.data as Float32Array);
    const p = probs[m.aiIndex] ?? Number.NaN;
    for (let i = ch.first; i <= ch.last; i++) perSentence[i] = p;
    chunkP.push(p);
    chunkW.push(Number(enc.input_ids?.dims?.[1] ?? 1));
    counter.tick("Running classifier");
  }
  return { perSentence, overall: weightedMean(chunkP, chunkW) };
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
  const perSentence = new Float64Array(n).fill(Number.NaN);
  for (const u of units) {
    const p = perplexityProbability(spanMean(mean, count, u.first, u.last), burst);
    for (let i = u.first; i <= u.last; i++) perSentence[i] = p;
  }
  const docLogPPL = finiteMean(nll);
  return { perSentence, overall: perplexityProbability(docLogPPL, burst), stat: docLogPPL, burst };
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
  const perSentence = new Float64Array(n).fill(Number.NaN);
  for (const u of units) {
    const s = binocularsScore(spanMean(a.mean, a.count, u.first, u.last), spanMean(b.mean, b.count, u.first, u.last));
    const p = binocularsProbability(s);
    for (let i = u.first; i <= u.last; i++) perSentence[i] = p;
  }
  const score = binocularsScore(finiteMean(nll), finiteMean(xent));
  return { perSentence, overall: binocularsProbability(score), stat: score };
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

  const slots = slotsForMode(opts.mode);
  const primary = models[slots[0]!];
  if (!primary) throw new Error(`Model for slot "${slots[0]}" is not loaded`);

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
  const units = buildUnits(words, opts.minWords);
  if (analysedWords < opts.minWords) {
    notes.push(
      `Only ${analysedWords} words: below the ${opts.minWords}-word minimum, so this score is low-confidence.`,
    );
  } else if (opts.mode !== "classifier" && opts.mode !== "classifierLite") {
    notes.push(`Sentence colours are scored in groups of at least ${opts.minWords} words.`);
  }

  // 3. Plan the work so progress has a real denominator.
  const idsFor = (m: LoadedModel) => (m === primary ? primaryIds.slice(0, n) : tokenizePieces(m, pieces));
  const plan: Array<() => Promise<void>> = [];
  let total = 0;
  let cls: ClassifierOut | undefined;
  let ppl: ProbOut | undefined;
  let bino: ProbOut | undefined;
  const counterRef: { c?: Counter } = {};

  if (opts.mode === "classifier" || opts.mode === "classifierLite" || opts.mode === "ensemble") {
    const slot: ModelSlot = opts.mode === "classifierLite" ? "classifierLite" : "classifier";
    const m = need(models, slot, "classifier");
    const counts = idsFor(m).map((ids) => ids.length);
    const chunks = packChunks(units, counts, m.maxLength - 2, CLASSIFIER_TARGET_TOKENS);
    total += chunks.length;
    plan.push(async () => {
      cls = await runClassifier(m, doc, n, counterRef.c!, chunks);
    });
  }
  if (opts.mode === "perplexity" || opts.mode === "ensemble") {
    const m = need(models, "perplexityLM", "lm");
    const ids = idsFor(m);
    const len = (m.bos !== null ? 1 : 0) + ids.reduce((a, x) => a + x.length, 0);
    total += planWindows(len, m.window, m.overlap).length;
    plan.push(async () => {
      ppl = await runPerplexity(m, ids, units, counterRef.c!);
    });
  }
  if (opts.mode === "binoculars") {
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
      bino = await runBinoculars(obs, perf, ids, units, counterRef.c!);
    });
    notes.push("Binoculars with 135M-parameter models is experimental and unvalidated.");
  }

  counterRef.c = makeCounter(Math.max(1, total), onProgress);
  onProgress?.({ phase: "analyze", loaded: 0, total: counterRef.c.total, message: "Analysing text" });
  for (const step of plan) await step();

  // 4. Combine into per-sentence scores.
  const out: SentenceScore[] = [];
  for (let i = 0; i < n; i++) {
    const sources: Partial<Record<ScoreSource, number>> = {};
    let score: number;
    const pc = cls?.perSentence[i] ?? Number.NaN;
    const pp = ppl?.perSentence[i] ?? Number.NaN;
    const pb = bino?.perSentence[i] ?? Number.NaN;
    if (Number.isFinite(pc)) sources.classifier = pc;
    if (Number.isFinite(pp)) sources.perplexity = pp;
    if (Number.isFinite(pb)) sources.binoculars = pb;
    switch (opts.mode) {
      case "classifier":
      case "classifierLite":
        score = pc;
        break;
      case "perplexity":
        score = pp;
        break;
      case "binoculars":
        score = pb;
        break;
      default:
        score = blendEnsemble(pc, pp);
    }
    out.push({ blockId: sentences[i]!.blockId, index: sentences[i]!.index, score: clamp01(score), sources });
  }

  let overall: number;
  switch (opts.mode) {
    case "classifier":
    case "classifierLite":
      overall = cls?.overall ?? Number.NaN;
      break;
    case "perplexity":
      overall = ppl?.overall ?? Number.NaN;
      break;
    case "binoculars":
      overall = bino?.overall ?? Number.NaN;
      break;
    default:
      overall = blendEnsemble(cls?.overall ?? Number.NaN, ppl?.overall ?? Number.NaN);
  }

  if (cls) stats.classifier = cls.overall;
  if (ppl) {
    stats.logPPL = ppl.stat;
    stats.burstiness = ppl.burst;
  }
  if (bino) stats.binoculars = bino.stat;

  const result: Analysis["result"] = { overall: clamp01(overall), sentences: out, notes };
  if (tooLong) result.tooLong = true;
  return { result, stats };
}
