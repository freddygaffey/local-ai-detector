import { describe, expect, test } from "vitest";
import { segmentSentences, wordCount } from "./segment";

describe("segmentSentences", () => {
  test("splits multiple sentences and covers the whole string with no gaps", () => {
    const text = "This is one. This is two! Is this three?";
    const spans = segmentSentences(text);
    expect(spans.length).toBe(3);
    expect(spans[0]!.start).toBe(0);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.start).toBe(spans[i - 1]!.end);
    }
    expect(spans[spans.length - 1]!.end).toBe(text.length);
  });

  test("offsets round-trip back to the exact substring", () => {
    const text = "First sentence here. Second one follows.";
    const spans = segmentSentences(text);
    for (const { start, end } of spans) {
      expect(text.slice(start, end).length).toBe(end - start);
    }
    expect(spans.map((s) => text.slice(s.start, s.end)).join("")).toBe(text);
  });

  test("empty string yields no spans", () => {
    expect(segmentSentences("")).toEqual([]);
  });

  test("single sentence with no terminal punctuation is still one span", () => {
    const text = "just some words with no period";
    const spans = segmentSentences(text);
    expect(spans.length).toBe(1);
    expect(spans[0]).toEqual({ start: 0, end: text.length });
  });
});

describe("wordCount", () => {
  test("counts whitespace-separated words", () => {
    expect(wordCount("one two three")).toBe(3);
  });
  test("empty/whitespace-only text is zero", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("   \n\t ")).toBe(0);
  });
  test("collapses runs of whitespace", () => {
    expect(wordCount("  one   two  ")).toBe(2);
  });
});
