import { describe, expect, it } from "vitest";
import {
  BLOCK_SEPARATOR,
  blockStarts,
  buildDoc,
  buildUnits,
  capSentences,
  countWords,
  hashString,
  packChunks,
  sentencePieces,
  spanIndexBySentence,
} from "./text";

describe("buildDoc", () => {
  it("joins blocks and re-bases sentence offsets", () => {
    const doc = buildDoc([
      { id: "a", text: "One two. Three four five.", sentences: [{ start: 0, end: 8 }, { start: 9, end: 25 }] },
      { id: "b", text: "Six.", sentences: [{ start: 0, end: 4 }] },
    ]);
    expect(doc.text).toBe(`One two. Three four five.${BLOCK_SEPARATOR}Six.`);
    expect(doc.sentences.map((s) => doc.text.slice(s.start, s.end))).toEqual([
      "One two.",
      "Three four five.",
      "Six.",
    ]);
    expect(doc.sentences.map((s) => [s.blockId, s.index, s.words])).toEqual([
      ["a", 0, 2],
      ["a", 1, 3],
      ["b", 0, 1],
    ]);
  });

  it("treats a block without sentence ranges as one sentence, and drops empty/invalid ranges", () => {
    const doc = buildDoc([
      { id: "a", text: "Whole block here", sentences: [] },
      { id: "b", text: "Hi. ", sentences: [{ start: 3, end: 4 }, { start: 0, end: 3 }, { start: 10, end: 2 }] },
      { id: "c", text: "", sentences: [{ start: 0, end: 0 }] },
    ]);
    expect(doc.sentences.map((s) => [s.blockId, s.index, doc.text.slice(s.start, s.end)])).toEqual([
      ["a", 0, "Whole block here"],
      ["b", 1, "Hi."],
    ]);
  });

  it("clips overlapping ranges so pieces never overlap", () => {
    const doc = buildDoc([{ id: "a", text: "abc def ghi", sentences: [{ start: 0, end: 7 }, { start: 4, end: 11 }] }]);
    expect(doc.sentences.map((s) => doc.text.slice(s.start, s.end))).toEqual(["abc def", " ghi"]);
  });
});

describe("sentencePieces", () => {
  it("concatenate back to the analysed text, with leading whitespace kept on each piece", () => {
    const doc = buildDoc([
      { id: "a", text: "  First one.  Second one.", sentences: [{ start: 2, end: 12 }, { start: 14, end: 25 }] },
      { id: "b", text: "Third.", sentences: [{ start: 0, end: 6 }] },
    ]);
    const pieces = sentencePieces(doc);
    expect(pieces).toEqual(["  First one.", "  Second one.", `${BLOCK_SEPARATOR}Third.`]);
    expect(pieces.join("")).toBe(doc.text);
  });
});

describe("countWords", () => {
  it("counts words including contractions, numbers and non-Latin letters", () => {
    expect(countWords("It's 2024 — naïve café, don't panic!")).toBe(6);
    expect(countWords("   ")).toBe(0);
    expect(countWords("Привет мир")).toBe(2);
  });
});

describe("capSentences", () => {
  it("keeps sentences while the running total fits", () => {
    expect(capSentences([10, 10, 10], 25)).toBe(2);
    expect(capSentences([10, 10, 10], 30)).toBe(3);
    expect(capSentences([], 30)).toBe(0);
  });
  it("always keeps at least one sentence", () => {
    expect(capSentences([100, 5], 10)).toBe(1);
  });
});

describe("buildUnits (minWords folding)", () => {
  it("groups short sentences until minWords is reached", () => {
    expect(buildUnits([3, 3, 3, 3, 3, 3], 6)).toEqual([
      { first: 0, last: 1 },
      { first: 2, last: 3 },
      { first: 4, last: 5 },
    ]);
  });
  it("merges a short trailing remainder into the previous unit", () => {
    expect(buildUnits([10, 10, 2], 10)).toEqual([
      { first: 0, last: 0 },
      { first: 1, last: 2 },
    ]);
  });
  it("makes one low-confidence unit when all text is below minWords", () => {
    expect(buildUnits([2, 3], 50)).toEqual([{ first: 0, last: 1 }]);
    expect(buildUnits([], 50)).toEqual([]);
  });
  it("gives long sentences their own unit", () => {
    expect(buildUnits([60, 5, 70], 50)).toEqual([
      { first: 0, last: 0 },
      { first: 1, last: 2 },
    ]);
  });
});

describe("block-aware grouping", () => {
  it("buildUnits swallows a too-short block tail instead of spilling into the next block", () => {
    // block A: 30 + 30 + 10 words, block B: 60 words
    const words = [30, 30, 10, 60];
    const starts = [true, false, false, true];
    expect(buildUnits(words, 50)).toEqual([
      { first: 0, last: 1 },
      { first: 2, last: 3 },
    ]);
    expect(buildUnits(words, 50, starts)).toEqual([
      { first: 0, last: 2 },
      { first: 3, last: 3 },
    ]);
  });

  it("buildUnits still merges whole short blocks with neighbours", () => {
    expect(buildUnits([10, 10, 60], 50, [true, true, true])).toEqual([{ first: 0, last: 2 }]);
  });

  it("packChunks starts a new chunk at a block boundary once half full", () => {
    const units = [
      { first: 0, last: 0 },
      { first: 1, last: 1 },
      { first: 2, last: 2 },
    ];
    const counts = [150, 60, 100];
    expect(packChunks(units, counts, 510, 384)).toEqual([{ first: 0, last: 2 }]);
    expect(packChunks(units, counts, 510, 384, [true, false, true])).toEqual([
      { first: 0, last: 1 },
      { first: 2, last: 2 },
    ]);
    // small blocks keep packing together until the chunk is half full
    expect(packChunks(units, [100, 20, 100], 510, 384, [true, true, true])).toEqual([{ first: 0, last: 2 }]);
    expect(packChunks(units, [200, 20, 100], 510, 384, [true, true, true])).toEqual([
      { first: 0, last: 0 },
      { first: 1, last: 2 },
    ]);
  });

  it("blockStarts marks the first sentence of each block", () => {
    const doc = buildDoc([
      { id: "a", text: "A b. C d.", sentences: [{ start: 0, end: 4 }, { start: 5, end: 9 }] },
      { id: "b", text: "E f.", sentences: [{ start: 0, end: 4 }] },
    ]);
    expect(blockStarts(doc.sentences)).toEqual([true, false, true]);
  });
});

describe("packChunks", () => {
  const units = [
    { first: 0, last: 1 },
    { first: 2, last: 2 },
    { first: 3, last: 4 },
  ];
  it("packs whole units up to maxTokens", () => {
    expect(packChunks(units, [100, 100, 150, 50, 50], 400)).toEqual([
      { first: 0, last: 2 },
      { first: 3, last: 4 },
    ]);
  });
  it("closes a chunk once it reaches the target size", () => {
    expect(packChunks(units, [100, 100, 150, 50, 50], 510, 200)).toEqual([
      { first: 0, last: 1 },
      { first: 2, last: 4 },
    ]);
  });
  it("splits an over-long unit on sentence boundaries, never mid-sentence", () => {
    expect(packChunks([{ first: 0, last: 3 }], [300, 300, 600, 10], 510)).toEqual([
      { first: 0, last: 0 },
      { first: 1, last: 1 },
      { first: 2, last: 2 },
      { first: 3, last: 3 },
    ]);
  });
  it("covers every sentence exactly once", () => {
    const counts = [40, 7, 300, 12, 90, 510, 3, 3, 3];
    const u = buildUnits([5, 5, 5, 5, 5, 5, 5, 5, 5], 10);
    const chunks = packChunks(u, counts, 128, 64);
    const idx = spanIndexBySentence(chunks, counts.length);
    expect([...idx].every((k) => k >= 0)).toBe(true);
    const flat = chunks.flatMap((c) => Array.from({ length: c.last - c.first + 1 }, (_, i) => c.first + i));
    expect(flat).toEqual(counts.map((_, i) => i));
  });
});

describe("hashString", () => {
  it("is stable and sensitive to content", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
  });
});

describe("buildUnits with hard block boundaries (thread items)", () => {
  it("never merges two items, however short", () => {
    // Three items: 10 words, 12 words (two sentences), 60 words.
    const words = [10, 6, 6, 30, 30];
    const starts = [true, true, false, true, false];
    expect(buildUnits(words, 50, starts, true)).toEqual([
      { first: 0, last: 0 },
      { first: 1, last: 2 },
      { first: 3, last: 4 },
    ]);
    // Without hard boundaries the short items fold into their neighbours.
    expect(buildUnits(words, 50, starts).length).toBeLessThan(3);
  });
});
