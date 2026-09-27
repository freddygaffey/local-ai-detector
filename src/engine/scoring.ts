// Pure scoring math: per-token log-probs from logits, sliding-window
// planning over a long token sequence, Binoculars cross-entropy, per-span
// aggregation, the sigmoid mappings to a 0..1 "AI likelihood", and the
// ensemble blend. No model/runtime imports, so it is unit-testable with fake
// logits.

import { CALIBRATION, type Calibration } from "./calibration";

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
export const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5);

/** log(sum(exp(row))) for row `pos` of a [T, V] logits buffer. */
export function logSumExpRow(data: ArrayLike<number>, pos: number, vocab: number): number {
  const off = pos * vocab;
  let max = -Infinity;
  for (let v = 0; v < vocab; v++) {
    const x = data[off + v];
    if (x > max) max = x;
  }
  let sum = 0;
  for (let v = 0; v < vocab; v++) sum += Math.exp(data[off + v] - max);
  return max + Math.log(sum);
}

/** Negative log-likelihood of `target` under row `pos` (natural log). */
export function tokenNLL(data: ArrayLike<number>, pos: number, vocab: number, target: number): number {
  return logSumExpRow(data, pos, vocab) - data[pos * vocab + target];
}

/**
 * Binoculars per-position cross-entropy: -sum_v softmax(obs)_v * log_softmax(perf)_v
 * (observer probabilities, performer log-probabilities), as in the reference
 * implementation's `entropy(observer_logits, performer_logits)`.
 */
export function crossEntropyRow(
  obs: ArrayLike<number>,
  perf: ArrayLike<number>,
  pos: number,
  vocab: number,
): number {
  const off = pos * vocab;
  const lseObs = logSumExpRow(obs, pos, vocab);
  const lsePerf = logSumExpRow(perf, pos, vocab);
  let acc = 0;
  for (let v = 0; v < vocab; v++) {
    const p = Math.exp(obs[off + v] - lseObs);
    acc += p * (lsePerf - perf[off + v]);
  }
  return acc;
}

export interface Window {
  /** Inclusive start / exclusive end, in sequence coordinates. */
  start: number;
  end: number;
  /** First sequence position whose token is scored in this window. */
  scoreFrom: number;
}

/**
 * Plans overlapping windows over a sequence of `length` tokens so every
 * position >= 1 is scored exactly once, with up to `overlap` tokens of
 * re-used left context at each window boundary (the standard strided
 * perplexity recipe). Position 0 is never scored (nothing predicts it), which
 * is why callers prepend a BOS token when the model has one.
 */
export function planWindows(length: number, window: number, overlap: number): Window[] {
  if (length < 2) return [];
  const w = Math.max(2, Math.floor(window));
  const ov = Math.max(0, Math.min(Math.floor(overlap), w - 1));
  const out: Window[] = [];
  let start = 0;
  let scoreFrom = 1;
  for (;;) {
    const end = Math.min(length, start + w);
    out.push({ start, end, scoreFrom });
    if (end >= length) break;
    scoreFrom = end;
    start = end - ov;
  }
  return out;
}

export interface LogitsOutput {
  /** Row-major [seqLen, vocab] (batch 1 squeezed). */
  data: ArrayLike<number>;
  vocab: number;
}

/** Runs a causal LM on `ids` and returns its logits. */
export type ForwardFn = (ids: number[]) => Promise<LogitsOutput>;

/**
 * Per-token NLL for `seq` (index-aligned; NaN where unscored, i.e. position 0)
 * via sliding windows.
 */
export async function sequenceNLL(
  forward: ForwardFn,
  seq: number[],
  window: number,
  overlap: number,
  onWindow?: (done: number, total: number) => void,
): Promise<Float64Array> {
  const nll = new Float64Array(seq.length).fill(Number.NaN);
  const windows = planWindows(seq.length, window, overlap);
  for (let k = 0; k < windows.length; k++) {
    const w = windows[k];
    const ids = seq.slice(w.start, w.end);
    const { data, vocab } = await forward(ids);
    for (let j = Math.max(w.scoreFrom, w.start + 1); j < w.end; j++) {
      nll[j] = tokenNLL(data, j - 1 - w.start, vocab, seq[j]);
    }
    onWindow?.(k + 1, windows.length);
  }
  return nll;
}

/**
 * Binoculars per-token terms for `seq`: performer NLL of the actual token and
 * observer/performer cross-entropy at the same position.
 */
export async function sequenceBinoculars(
  observer: ForwardFn,
  performer: ForwardFn,
  seq: number[],
  window: number,
  overlap: number,
  onWindow?: (done: number, total: number) => void,
): Promise<{ nll: Float64Array; xent: Float64Array }> {
  const nll = new Float64Array(seq.length).fill(Number.NaN);
  const xent = new Float64Array(seq.length).fill(Number.NaN);
  const windows = planWindows(seq.length, window, overlap);
  for (let k = 0; k < windows.length; k++) {
    const w = windows[k];
    const ids = seq.slice(w.start, w.end);
    const obs = await observer(ids);
    const perf = await performer(ids);
    if (obs.vocab !== perf.vocab) {
      throw new Error(`Binoculars models disagree on vocabulary size (${obs.vocab} vs ${perf.vocab})`);
    }
    for (let j = Math.max(w.scoreFrom, w.start + 1); j < w.end; j++) {
      const row = j - 1 - w.start;
      nll[j] = tokenNLL(perf.data, row, perf.vocab, seq[j]);
      xent[j] = crossEntropyRow(obs.data, perf.data, row, obs.vocab);
    }
    onWindow?.(k + 1, windows.length);
  }
  return { nll, xent };
}

/** Mean of the finite values in `values[from..to)`; NaN if none. */
export function finiteMean(values: ArrayLike<number>, from = 0, to = values.length): number {
  let sum = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : Number.NaN;
}

/**
 * Mean per-token value for each sentence, given `tokenSentence[j]` = sentence
 * index of token j (or -1 for prefix tokens).
 */
export function perSentenceMean(
  values: ArrayLike<number>,
  tokenSentence: ArrayLike<number>,
  sentenceCount: number,
): { mean: Float64Array; count: Int32Array } {
  const sum = new Float64Array(sentenceCount);
  const count = new Int32Array(sentenceCount);
  for (let j = 0; j < values.length; j++) {
    const s = tokenSentence[j];
    const v = values[j];
    if (s < 0 || s >= sentenceCount || !Number.isFinite(v)) continue;
    sum[s] += v;
    count[s]++;
  }
  const mean = new Float64Array(sentenceCount);
  for (let s = 0; s < sentenceCount; s++) mean[s] = count[s] > 0 ? sum[s] / count[s] : Number.NaN;
  return { mean, count };
}

/** Token-weighted mean over a span of sentences, from per-sentence means and counts. */
export function spanMean(
  mean: ArrayLike<number>,
  count: ArrayLike<number>,
  first: number,
  last: number,
): number {
  let sum = 0;
  let n = 0;
  for (let i = first; i <= last; i++) {
    if (count[i] > 0 && Number.isFinite(mean[i])) {
      sum += mean[i] * count[i];
      n += count[i];
    }
  }
  return n > 0 ? sum / n : Number.NaN;
}

/**
 * Burstiness = standard deviation of per-sentence mean NLL (log-perplexity)
 * across sentences with at least `minTokens` tokens. Human writing tends to
 * vary more from sentence to sentence. Returns NaN with fewer than 3 usable
 * sentences.
 */
export function burstiness(mean: ArrayLike<number>, count: ArrayLike<number>, minTokens = 5): number {
  const xs: number[] = [];
  for (let i = 0; i < mean.length; i++) {
    if (count[i] >= minTokens && Number.isFinite(mean[i])) xs.push(mean[i]);
  }
  if (xs.length < 3) return Number.NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/**
 * Perplexity detector mapping: low log-perplexity (predictable text) and low
 * burstiness push towards "AI".
 *   p = sigmoid(a * (tau - logPPL) + b * (tauBurst - burstiness))
 * The burstiness term is dropped when burstiness is unavailable (NaN).
 */
export function perplexityProbability(
  logPPL: number,
  burst: number,
  cal: Calibration["perplexity"] = CALIBRATION.perplexity,
): number {
  if (!Number.isFinite(logPPL)) return Number.NaN;
  let z = cal.a * (cal.tau - logPPL);
  if (Number.isFinite(burst)) z += cal.b * (cal.tauBurst - burst);
  return sigmoid(z);
}

/**
 * Binoculars mapping: score = logPPL_performer / crossEntropy(observer, performer).
 * Lower means more AI-like. p = sigmoid(k * (tau - score)).
 */
export function binocularsScore(meanNLL: number, meanXent: number): number {
  if (!Number.isFinite(meanNLL) || !Number.isFinite(meanXent) || meanXent <= 0) return Number.NaN;
  return meanNLL / meanXent;
}

export function binocularsProbability(
  score: number,
  cal: Calibration["binoculars"] = CALIBRATION.binoculars,
): number {
  if (!Number.isFinite(score)) return Number.NaN;
  return sigmoid(cal.k * (cal.tau - score));
}

/**
 * Ensemble blend (documented in docs/calibration.md):
 *   p = (wC * p_classifier + wP * p_perplexity) / (wC + wP)
 * A plain weighted average in probability space: easy to explain in the UI,
 * and it can never be more extreme than its most extreme input. If one input
 * is missing (NaN), the other is used alone.
 */
export function blendEnsemble(
  pClassifier: number,
  pPerplexity: number,
  cal: Calibration["ensemble"] = CALIBRATION.ensemble,
): number {
  const hasC = Number.isFinite(pClassifier);
  const hasP = Number.isFinite(pPerplexity);
  if (hasC && hasP) {
    return (cal.wClassifier * pClassifier + cal.wPerplexity * pPerplexity) / (cal.wClassifier + cal.wPerplexity);
  }
  if (hasC) return pClassifier;
  if (hasP) return pPerplexity;
  return Number.NaN;
}

/** Weighted mean of finite values; NaN if no weight. */
export function weightedMean(values: ArrayLike<number>, weights: ArrayLike<number>): number {
  let sum = 0;
  let w = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const wi = weights[i];
    if (!Number.isFinite(v) || !(wi > 0)) continue;
    sum += v * wi;
    w += wi;
  }
  return w > 0 ? sum / w : Number.NaN;
}

/** Softmax over a small logits vector (classifier heads). */
export function softmax(logits: ArrayLike<number>): number[] {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) max = Math.max(max, logits[i]);
  const exps = Array.from(logits, (x) => Math.exp(x - max));
  const s = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / s);
}

/**
 * Picks the class index that means "AI-generated" from a model's id2label.
 * Recognises common names (ai, fake, machine, generated, gpt, llm, label_1)
 * and falls back to index 1 for binary heads (the convention of every
 * RAID-trained detector we ship).
 */
export function aiLabelIndex(id2label: Record<string | number, string> | undefined, numLabels: number): number {
  const human = /^(human|real|original|label_0|0)$/i;
  const ai = /(^ai$|^ai[-_ ]|artificial|fake|machine|generated|gpt|llm|chatgpt|^label_1$|^1$)/i;
  if (id2label) {
    for (const [k, v] of Object.entries(id2label)) {
      if (ai.test(String(v)) && !human.test(String(v))) return Number(k);
    }
    const entries = Object.entries(id2label);
    if (entries.length === 2) {
      const h = entries.find(([, v]) => human.test(String(v)));
      if (h) return Number(entries.find(([k]) => k !== h[0])![0]);
    }
  }
  return numLabels >= 2 ? 1 : 0;
}
