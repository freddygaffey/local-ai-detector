import { describe, expect, test } from "vitest";
import { clamp01, formatBytes, formatMB, formatPercent, pluralize, shortSha, toPercentInt } from "./format";

describe("formatBytes", () => {
  test("zero and small values", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(512)).toBe("512 B");
  });
  test("MB range, one decimal, trimmed", () => {
    expect(formatBytes(126 * 1024 * 1024)).toBe("126 MB");
    expect(formatBytes(34.2 * 1024 * 1024)).toBe("34.2 MB");
  });
  test("GB range", () => {
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });
  test("negative/NaN are clamped to zero", () => {
    expect(formatBytes(-5)).toBe("0 MB");
    expect(formatBytes(Number.NaN)).toBe("0 MB");
  });
});

describe("formatMB", () => {
  test("delegates to formatBytes", () => {
    expect(formatMB(211)).toBe("211 MB");
  });
});

describe("formatPercent / toPercentInt", () => {
  test("rounds to whole percent", () => {
    expect(formatPercent(0.421)).toBe("42%");
    expect(toPercentInt(0.421)).toBe(42);
  });
  test("clamps out-of-range scores", () => {
    expect(formatPercent(1.4)).toBe("100%");
    expect(formatPercent(-0.4)).toBe("0%");
  });
});

describe("clamp01", () => {
  test("clamps and handles NaN", () => {
    expect(clamp01(2)).toBe(1);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe("shortSha", () => {
  test("shortens a hex sha", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });
  test("leaves non-sha revisions (branch names) as-is", () => {
    expect(shortSha("main")).toBe("main");
  });
  test("empty revision", () => {
    expect(shortSha("")).toBe("—");
  });
});

describe("pluralize", () => {
  test("singular vs plural", () => {
    expect(pluralize(1, "sentence")).toBe("1 sentence");
    expect(pluralize(3, "sentence")).toBe("3 sentences");
    expect(pluralize(0, "sentence")).toBe("0 sentences");
  });
});
