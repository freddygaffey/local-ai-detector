import { describe, expect, test } from "vitest";
import { formatCounter, orderFlagged, stepIndex } from "./navigation";

describe("orderFlagged", () => {
  test("orders by block order, then sentence index", () => {
    const blockOrder = ["b1", "b2", "b3"];
    const keys = [
      { blockId: "b2", index: 1 },
      { blockId: "b1", index: 2 },
      { blockId: "b1", index: 0 },
      { blockId: "b3", index: 0 },
    ];
    expect(orderFlagged(keys, blockOrder)).toEqual([
      { blockId: "b1", index: 0 },
      { blockId: "b1", index: 2 },
      { blockId: "b2", index: 1 },
      { blockId: "b3", index: 0 },
    ]);
  });

  test("unknown blocks sort after known ones instead of throwing", () => {
    const result = orderFlagged([{ blockId: "ghost", index: 0 }], ["b1"]);
    expect(result).toEqual([{ blockId: "ghost", index: 0 }]);
  });
});

describe("stepIndex", () => {
  test("wraps forward past the end", () => {
    expect(stepIndex(4, 5, 1)).toBe(0);
  });
  test("wraps backward past the start", () => {
    expect(stepIndex(0, 5, -1)).toBe(4);
  });
  test("starts at 0 going forward from no selection", () => {
    expect(stepIndex(-1, 5, 1)).toBe(0);
  });
  test("starts at the last item going backward from no selection", () => {
    expect(stepIndex(-1, 5, -1)).toBe(4);
  });
  test("returns -1 when there is nothing flagged", () => {
    expect(stepIndex(-1, 0, 1)).toBe(-1);
  });
  test("ordinary forward/backward step", () => {
    expect(stepIndex(2, 5, 1)).toBe(3);
    expect(stepIndex(2, 5, -1)).toBe(1);
  });
});

describe("formatCounter", () => {
  test("1-indexes for display", () => {
    expect(formatCounter(0, 5)).toBe("1/5");
    expect(formatCounter(4, 5)).toBe("5/5");
  });
  test("zero total", () => {
    expect(formatCounter(-1, 0)).toBe("0/0");
  });
  test("clamps an out-of-range current index", () => {
    expect(formatCounter(99, 3)).toBe("3/3");
    expect(formatCounter(-5, 3)).toBe("1/3");
  });
});
