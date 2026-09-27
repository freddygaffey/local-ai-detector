import { describe, expect, it } from "vitest";
import { CALIBRATION } from "./calibration";
import {
  aiLabelIndex,
  binocularsProbability,
  binocularsScore,
  blendEnsemble,
  burstiness,
  crossEntropyRow,
  finiteMean,
  logSumExpRow,
  perSentenceMean,
  perplexityProbability,
  planWindows,
  recalibrateClassifier,
  sequenceBinoculars,
  sequenceNLL,
  softmax,
  spanMean,
  tokenNLL,
  weightedMean,
  type ForwardFn,
} from "./scoring";

describe("log-prob helpers", () => {
  it("logSumExp / tokenNLL match a direct computation", () => {
    const row = [1, 2, 3, 0.5];
    const lse = Math.log(row.reduce((a, x) => a + Math.exp(x), 0));
    expect(logSumExpRow(row, 0, 4)).toBeCloseTo(lse, 10);
    expect(tokenNLL(row, 0, 4, 2)).toBeCloseTo(lse - 3, 10);
    // second row of a [2, 4] buffer
    expect(tokenNLL([0, 0, 0, 0, ...row], 1, 4, 1)).toBeCloseTo(lse - 2, 10);
  });

  it("is numerically stable for large logits", () => {
    expect(tokenNLL([1000, 1000], 0, 2, 0)).toBeCloseTo(Math.log(2), 10);
  });

  it("cross-entropy of a distribution with itself equals its entropy", () => {
    const row = [0.1, 1.3, -2, 0.7];
    const p = softmax(row);
    const entropy = -p.reduce((a, pi) => a + pi * Math.log(pi), 0);
    expect(crossEntropyRow(row, row, 0, 4)).toBeCloseTo(entropy, 10);
  });
});

describe("planWindows", () => {
  it("scores every position >= 1 exactly once", () => {
    for (const [len, w, ov] of [
      [1, 8, 2],
      [5, 8, 2],
      [8, 8, 2],
      [9, 8, 2],
      [100, 16, 4],
      [1000, 512, 128],
    ] as const) {
      const wins = planWindows(len, w, ov);
      const seen = new Array(len).fill(0);
      for (const win of wins) {
        expect(win.end - win.start).toBeLessThanOrEqual(w);
        for (let j = Math.max(win.scoreFrom, win.start + 1); j < win.end; j++) seen[j]++;
      }
      expect(seen.slice(1).every((c) => c === 1)).toBe(true);
      expect(seen[0]).toBe(0);
    }
  });

  it("re-uses `overlap` tokens of left context", () => {
    expect(planWindows(20, 10, 3)).toEqual([
      { start: 0, end: 10, scoreFrom: 1 },
      { start: 7, end: 17, scoreFrom: 10 },
      { start: 14, end: 20, scoreFrom: 17 },
    ]);
  });
});

// A fake "LM" over vocab V whose logits favour token (prev + 1) % V, so a
// counting sequence is predictable and a shuffled one is not.
function countingLM(V: number, strength: number): ForwardFn {
  return async (ids) => {
    const data = new Float32Array(ids.length * V);
    ids.forEach((t, i) => {
      data[i * V + ((t + 1) % V)] = strength;
    });
    return { data, vocab: V };
  };
}

describe("sequenceNLL", () => {
  it("gives the same per-token NLL regardless of window size (context-free fake LM)", async () => {
    const seq = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2];
    const a = await sequenceNLL(countingLM(10, 5), seq, 4, 1);
    const b = await sequenceNLL(countingLM(10, 5), seq, 64, 0);
    expect(Number.isNaN(a[0])).toBe(true);
    for (let j = 1; j < seq.length; j++) expect(a[j]).toBeCloseTo(b[j]!, 6);
  });

  it("predictable text has lower NLL than unpredictable text", async () => {
    const lm = countingLM(10, 5);
    const predictable = await sequenceNLL(lm, [0, 1, 2, 3, 4, 5, 6, 7], 8, 0);
    const random = await sequenceNLL(lm, [0, 7, 2, 9, 4, 1, 6, 3], 8, 0);
    expect(finiteMean(predictable)).toBeLessThan(finiteMean(random));
  });

  it("reports window progress", async () => {
    const calls: number[] = [];
    await sequenceNLL(countingLM(10, 1), new Array(20).fill(1), 8, 2, (d) => calls.push(d));
    expect(calls).toEqual([1, 2, 3]);
  });
});

describe("sequenceBinoculars", () => {
  it("returns per-token performer NLL and cross-entropy; rejects vocab mismatch", async () => {
    const seq = [0, 1, 2, 3, 4];
    const { nll, xent } = await sequenceBinoculars(countingLM(10, 4), countingLM(10, 4), seq, 8, 0);
    expect(Number.isNaN(nll[0])).toBe(true);
    for (let j = 1; j < seq.length; j++) {
      expect(nll[j]).toBeGreaterThan(0);
      expect(xent[j]).toBeGreaterThan(0);
    }
    await expect(sequenceBinoculars(countingLM(10, 4), countingLM(12, 4), seq, 8, 0)).rejects.toThrow(/vocabulary/);
  });
});

describe("aggregation", () => {
  it("perSentenceMean / spanMean are token-weighted and skip prefix tokens", () => {
    const values = [Number.NaN, 1, 3, 2, 2, 2, 10];
    const tokenSentence = [-1, 0, 0, 1, 1, 1, 2];
    const { mean, count } = perSentenceMean(values, tokenSentence, 3);
    expect([...mean]).toEqual([2, 2, 10]);
    expect([...count]).toEqual([2, 3, 1]);
    expect(spanMean(mean, count, 0, 1)).toBeCloseTo(2, 10);
    expect(spanMean(mean, count, 0, 2)).toBeCloseTo((4 + 6 + 10) / 6, 10);
  });

  it("burstiness is the std-dev of usable sentence means, NaN with < 3 sentences", () => {
    expect(burstiness([1, 2, 3], [5, 5, 5])).toBeCloseTo(1, 10);
    expect(Number.isNaN(burstiness([1, 2, 3], [5, 5, 1]))).toBe(true);
  });

  it("weightedMean ignores NaN and zero weights", () => {
    expect(weightedMean([0.2, Number.NaN, 0.8], [1, 5, 3])).toBeCloseTo((0.2 + 2.4) / 4, 10);
    expect(Number.isNaN(weightedMean([Number.NaN], [1]))).toBe(true);
  });
});

describe("probability mappings", () => {
  const cal = { tau: 3.5, a: 2, tauBurst: 0.6, b: 1 };
  it("perplexity: lower log-PPL and lower burstiness mean more AI-like", () => {
    const pLow = perplexityProbability(cal.tau - 1, Number.NaN, cal);
    const pHigh = perplexityProbability(cal.tau + 1, Number.NaN, cal);
    expect(pLow).toBeGreaterThan(0.5);
    expect(pHigh).toBeLessThan(0.5);
    expect(perplexityProbability(cal.tau, Number.NaN, cal)).toBeCloseTo(0.5, 10);
    expect(perplexityProbability(cal.tau, cal.tauBurst - 0.5, cal)).toBeGreaterThan(
      perplexityProbability(cal.tau, cal.tauBurst + 0.5, cal),
    );
    expect(Number.isNaN(perplexityProbability(Number.NaN, 1, cal))).toBe(true);
  });

  it("shipped perplexity calibration maps tau to 0.5", () => {
    const shipped = CALIBRATION.perplexity;
    expect(perplexityProbability(shipped.tau, shipped.tauBurst)).toBeCloseTo(0.5, 10);
  });

  it("classifier recalibration is monotone and identity without parameters", () => {
    const c = { center: 4, slope: 1.3 };
    expect(recalibrateClassifier(0.3, undefined)).toBe(0.3);
    const xs = [0.1, 0.5, 0.9, 0.98, 0.99].map((p) => recalibrateClassifier(p, c));
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]!);
    expect(recalibrateClassifier(1 / (1 + Math.exp(-4)), c)).toBeCloseTo(0.5, 6);
  });

  it("binoculars: score = nll / xent, lower score means more AI-like", () => {
    expect(binocularsScore(2, 4)).toBe(0.5);
    expect(Number.isNaN(binocularsScore(2, 0))).toBe(true);
    const tau = CALIBRATION.binoculars.tau;
    expect(binocularsProbability(tau - 0.1)).toBeGreaterThan(0.5);
    expect(binocularsProbability(tau + 0.1)).toBeLessThan(0.5);
  });
});

describe("blendEnsemble", () => {
  const w = { wClassifier: 0.6, wPerplexity: 0.4 };
  it("is the normalised weighted average of both detectors", () => {
    expect(blendEnsemble(1, 0, w)).toBeCloseTo(0.6, 10);
    expect(blendEnsemble(0.5, 0.5, w)).toBeCloseTo(0.5, 10);
    expect(blendEnsemble(0.9, 0.3, { wClassifier: 2, wPerplexity: 2 })).toBeCloseTo(0.6, 10);
  });
  it("never leaves the range of its inputs", () => {
    for (const [a, b] of [
      [0.1, 0.9],
      [0.99, 0.01],
      [0.4, 0.45],
    ]) {
      const p = blendEnsemble(a!, b!, w);
      expect(p).toBeGreaterThanOrEqual(Math.min(a!, b!));
      expect(p).toBeLessThanOrEqual(Math.max(a!, b!));
    }
  });
  it("falls back to whichever input exists", () => {
    expect(blendEnsemble(Number.NaN, 0.3, w)).toBe(0.3);
    expect(blendEnsemble(0.7, Number.NaN, w)).toBe(0.7);
    expect(Number.isNaN(blendEnsemble(Number.NaN, Number.NaN, w))).toBe(true);
  });
});

describe("aiLabelIndex", () => {
  it("finds the AI class from common label names", () => {
    expect(aiLabelIndex({ 0: "human", 1: "ai" }, 2)).toBe(1);
    expect(aiLabelIndex({ 0: "Fake", 1: "Real" }, 2)).toBe(0);
    expect(aiLabelIndex({ 0: "machine-generated", 1: "human-written" }, 2)).toBe(0);
    expect(aiLabelIndex({ 0: "LABEL_0", 1: "LABEL_1" }, 2)).toBe(1);
    expect(aiLabelIndex({ 0: "Human", 1: "Other" }, 2)).toBe(1);
    expect(aiLabelIndex(undefined, 2)).toBe(1);
  });
});
