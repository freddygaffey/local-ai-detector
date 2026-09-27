import { describe, expect, test } from "vitest";
import { BAND_LABEL, bandClassName, bandColorVar, bandFromResult, scoreToBand } from "./verdict";
import type { AnalyzeResult } from "../shared/messages";
import { DEFAULT_SETTINGS } from "../shared/settings";

function result(overall: number, sentenceCount: number): AnalyzeResult {
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
  };
}

describe("scoreToBand", () => {
  test("low score is human", () => {
    expect(scoreToBand({ overall: 0.1, hasScoredSentences: true })).toBe("human");
  });
  test("high score is ai", () => {
    expect(scoreToBand({ overall: 0.9, hasScoredSentences: true })).toBe("ai");
  });
  test("middle score is mixed", () => {
    expect(scoreToBand({ overall: 0.5, hasScoredSentences: true })).toBe("mixed");
  });
  test("boundaries are inclusive of the mixed band", () => {
    expect(scoreToBand({ overall: 0.35, hasScoredSentences: true })).toBe("mixed");
    expect(scoreToBand({ overall: 0.649, hasScoredSentences: true })).toBe("mixed");
    expect(scoreToBand({ overall: 0.65, hasScoredSentences: true })).toBe("ai");
  });
  test("no scored sentences is insufficient regardless of score", () => {
    expect(scoreToBand({ overall: 0.9, hasScoredSentences: false })).toBe("insufficient");
  });
});

describe("bandFromResult", () => {
  test("empty sentences -> insufficient", () => {
    expect(bandFromResult(result(0.8, 0), DEFAULT_SETTINGS)).toBe("insufficient");
  });
  test("scored sentences use the score", () => {
    expect(bandFromResult(result(0.1, 3), DEFAULT_SETTINGS)).toBe("human");
    expect(bandFromResult(result(0.9, 3), DEFAULT_SETTINGS)).toBe("ai");
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
