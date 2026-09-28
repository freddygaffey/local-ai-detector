import { describe, expect, test } from "vitest";
import { remapBlocks } from "./resultCache";
import type { AnalyzeResult } from "../shared/messages";

describe("remembered results", () => {
  test("block ids move onto this visit's ids by position", () => {
    const r = {
      overall: 0.4,
      notes: [],
      unicode: { findings: [], totalSuspicious: 0, score: 0, hiddenMessage: null },
      sentences: [
        { blockId: "blk-1-1", index: 0, score: 0.1, sources: {} },
        { blockId: "blk-1-2", index: 0, score: 0.9, sources: {} },
        { blockId: "blk-1-2", index: 1, score: 0.5, sources: {} },
      ],
    } as unknown as AnalyzeResult;
    const out = remapBlocks(r, ["blk-1-1", "blk-1-2"], ["blk-9-7", "blk-9-8"]);
    expect(out.sentences.map((s) => [s.blockId, s.index, s.score])).toEqual([
      ["blk-9-7", 0, 0.1],
      ["blk-9-8", 0, 0.9],
      ["blk-9-8", 1, 0.5],
    ]);
    expect(r.sentences[0]!.blockId).toBe("blk-1-1"); // the cached copy is untouched
  });
});
