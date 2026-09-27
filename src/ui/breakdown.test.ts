import { describe, expect, test } from "vitest";
import { aggregateSources, countFlaggedSentences } from "./breakdown";
import type { SentenceScore } from "../shared/messages";

function s(score: number, sources: SentenceScore["sources"] = {}): SentenceScore {
  return { blockId: "b", index: 0, score, sources };
}

describe("countFlaggedSentences", () => {
  test("counts sentences at/above the threshold", () => {
    const sentences = [s(0.1), s(0.65), s(0.8), s(0.64)];
    expect(countFlaggedSentences(sentences)).toBe(2);
  });
  test("empty input", () => {
    expect(countFlaggedSentences([])).toBe(0);
  });
  test("custom threshold", () => {
    expect(countFlaggedSentences([s(0.5), s(0.6)], 0.55)).toBe(1);
  });
});

describe("aggregateSources", () => {
  test("averages each source across sentences that reported it", () => {
    const sentences = [
      s(0.5, { classifier: 0.4, perplexity: 0.2 }),
      s(0.6, { classifier: 0.6 }),
    ];
    const agg = aggregateSources(sentences);
    expect(agg.classifier).toBeCloseTo(0.5);
    expect(agg.perplexity).toBeCloseTo(0.2);
    expect(agg.binoculars).toBeUndefined();
  });
  test("empty input gives an empty object", () => {
    expect(aggregateSources([])).toEqual({});
  });
});
