import { describe, expect, test } from "vitest";
import {
  GAUGE_RADIUS,
  GAUGE_START_DEG,
  GAUGE_SWEEP_DEG,
  angleForScore,
  arcLength,
  clamp01,
  dashOffsetForScore,
  describeArc,
  polarToCartesian,
} from "./gauge";

describe("clamp01", () => {
  test("clamps and handles NaN", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe("polarToCartesian", () => {
  test("0 degrees points straight up from centre", () => {
    const p = polarToCartesian(100, 100, 50, 0);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(50);
  });
  test("90 degrees points right", () => {
    const p = polarToCartesian(100, 100, 50, 90);
    expect(p.x).toBeCloseTo(150);
    expect(p.y).toBeCloseTo(100);
  });
});

describe("angleForScore", () => {
  test("0 -> start angle, 1 -> start + sweep", () => {
    expect(angleForScore(0)).toBe(GAUGE_START_DEG);
    expect(angleForScore(1)).toBe(GAUGE_START_DEG + GAUGE_SWEEP_DEG);
  });
  test("0.5 is the midpoint", () => {
    expect(angleForScore(0.5)).toBeCloseTo(GAUGE_START_DEG + GAUGE_SWEEP_DEG / 2);
  });
  test("out-of-range scores are clamped", () => {
    expect(angleForScore(-1)).toBe(GAUGE_START_DEG);
    expect(angleForScore(5)).toBe(GAUGE_START_DEG + GAUGE_SWEEP_DEG);
  });
});

describe("arcLength", () => {
  test("matches r * theta(radians)", () => {
    expect(arcLength(100, 180)).toBeCloseTo(100 * Math.PI);
    expect(arcLength(GAUGE_RADIUS, 360)).toBeCloseTo(2 * Math.PI * GAUGE_RADIUS);
  });
});

describe("dashOffsetForScore", () => {
  test("0 score -> full offset (empty dial)", () => {
    expect(dashOffsetForScore(0, 100)).toBe(100);
  });
  test("1 score -> zero offset (full dial)", () => {
    expect(dashOffsetForScore(1, 100)).toBe(0);
  });
  test("0.5 score -> half offset", () => {
    expect(dashOffsetForScore(0.5, 100)).toBe(50);
  });
});

describe("describeArc", () => {
  test("produces a valid SVG arc path", () => {
    const d = describeArc(100, 100, 50, GAUGE_START_DEG, GAUGE_START_DEG + GAUGE_SWEEP_DEG);
    expect(d.startsWith("M ")).toBe(true);
    expect(d).toContain(" A ");
  });
  test("uses the large-arc flag for a >180deg sweep", () => {
    const d = describeArc(100, 100, 50, 0, 270);
    const largeArcFlag = d.split(" A ")[1]!.split(" ")[3];
    expect(largeArcFlag).toBe("1");
  });
  test("uses the small-arc flag for a <=180deg sweep", () => {
    const d = describeArc(100, 100, 50, 0, 90);
    const largeArcFlag = d.split(" A ")[1]!.split(" ")[3];
    expect(largeArcFlag).toBe("0");
  });
});
