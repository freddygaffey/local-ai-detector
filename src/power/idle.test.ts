import { describe, expect, test } from "vitest";
import { isIdleTooLong } from "./idle";

describe("isIdleTooLong", () => {
  test("false before the threshold", () => {
    expect(isIdleTooLong(1000, 1000 + 4 * 60_000, 5)).toBe(false);
  });
  test("true at/after the threshold", () => {
    expect(isIdleTooLong(1000, 1000 + 5 * 60_000, 5)).toBe(true);
    expect(isIdleTooLong(1000, 1000 + 60 * 60_000, 5)).toBe(true);
  });
  test("0 (or negative) minutes means never unload", () => {
    expect(isIdleTooLong(0, 1e9, 0)).toBe(false);
    expect(isIdleTooLong(0, 1e9, -1)).toBe(false);
  });
});
