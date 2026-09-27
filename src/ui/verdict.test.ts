import { describe, expect, test } from "vitest";
import { BAND_LABEL, bandClassName, bandColorVar, bandFromResult, scoreToBand } from "./verdict";
import type { AnalyzeResult } from "../shared/messages";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { FLAGGED_THRESHOLD, HUMAN_MAX, toDisplayProbability } from "../shared/thresholds";

// The band cut points are T7's calibration curve, not our own constants
// (see verdict.ts `bandCutoffs`) -- computed here rather than hard-coded so
// this test doesn't have to know the curve's shape, only that whatever it
// maps HUMAN_MAX/FLAGGED_THRESHOLD to are the boundaries `scoreToBand` uses.
const HUMAN_CUT = toDisplayProbability(HUMAN_MAX);
const AI_CUT = toDisplayProbability(FLAGGED_THRESHOLD);

function result(overall: number, sentenceCount: number, extra: Partial<AnalyzeResult> = {}): AnalyzeResult {
  return {
    overall,
    sentences: Array.from({ length: sentenceCount }, (_, i) => ({
      blockId: "b",
      index: i,
      score: overall,
      sources: {},
    })),
    unicode: { findings: [], totalSuspicious: 0, score: 0, hiddenMessage: null },
    notes: [],
    ...extra,
  };
}

describe("scoreToBand", () => {
  test("low displayed probability is human", () => {
    expect(scoreToBand({ displayed: Math.max(0, HUMAN_CUT - 0.05) })).toBe("human");
  });
  test("high displayed probability is ai", () => {
    expect(scoreToBand({ displayed: Math.min(1, AI_CUT + 0.05) })).toBe("ai");
  });
  test("in between is mixed", () => {
    if (AI_CUT > HUMAN_CUT) expect(scoreToBand({ displayed: (HUMAN_CUT + AI_CUT) / 2 })).toBe("mixed");
  });
  test("the AI cut point itself is ai; just below it, never human", () => {
    expect(scoreToBand({ displayed: AI_CUT })).toBe("ai");
    expect(scoreToBand({ displayed: Math.max(0, AI_CUT - 0.001) })).not.toBe("human");
  });
  test("null (nothing to show) is insufficient regardless of anything else", () => {
    expect(scoreToBand({ displayed: null })).toBe("insufficient");
  });
});

describe("bandFromResult", () => {
  test("empty sentences -> insufficient", () => {
    expect(bandFromResult(result(0.8, 0), DEFAULT_SETTINGS)).toBe("insufficient");
  });
  test("scored sentences use the displayed (calibrated) probability", () => {
    expect(bandFromResult(result(0.1, 3), DEFAULT_SETTINGS)).toBe("human");
    expect(bandFromResult(result(0.9, 3), DEFAULT_SETTINGS)).toBe("ai");
  });
  test("regression: the band must follow result.probability, not the raw overall score (T7 merge finding)", () => {
    // Same context (detectors/device/words) the engine would have used to
    // compute `probability`, so the cut points below are the ones that
    // actually apply to this result -- not the context-free pooled curve.
    const ctx = { detectors: ["fakespot", "tmr"] as const, method: "weighted" as const, device: "webgpu" as const, words: 200 };
    const detectors = ctx.detectors.map((id) => ({ id, label: id, overall: 0.5, device: ctx.device, dtype: "q8", weight: 1 }));
    const fusion = { method: ctx.method, agreement: { agree: 2, total: 2, disagree: false } };
    const aiCut = toDisplayProbability(FLAGGED_THRESHOLD, ctx);
    const humanCut = toDisplayProbability(HUMAN_MAX, ctx);
    // A raw `overall` that reads "mixed" on the old raw-score thresholds,
    // but a calibrated `probability` clearly above the AI cut point: the
    // band shown must match the number shown, not the raw score underneath it.
    const r = result(0.42, 3, { probability: Math.min(0.99, aiCut + 0.02), detectors, device: ctx.device, words: ctx.words, fusion });
    expect(bandFromResult(r, DEFAULT_SETTINGS)).toBe("ai");
    // And the reverse: a high raw overall but a calibrated probability below the human cut point reads "human".
    const r2 = result(0.9, 3, { probability: Math.max(0.01, humanCut - 0.02), detectors, device: ctx.device, words: ctx.words, fusion });
    expect(bandFromResult(r2, DEFAULT_SETTINGS)).toBe("human");
  });
});

describe("labels and styling hooks", () => {
  test("every band has a non-accusatory label", () => {
    for (const label of Object.values(BAND_LABEL)) {
      expect(label.toLowerCase()).not.toContain("is ai");
      expect(label.toLowerCase()).not.toContain("plagiar");
    }
  });
  test("bandColorVar and bandClassName cover every band", () => {
    for (const band of ["human", "mixed", "ai", "insufficient"] as const) {
      expect(bandColorVar(band)).toMatch(/^var\(--/);
      expect(bandClassName(band)).toBe(`band-${band}`);
    }
  });
});
