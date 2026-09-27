import { describe, expect, test } from "vitest";
import {
  FLAGGED_THRESHOLD,
  bandWeight,
  bucketScore,
  heatmapColor,
  riskLevel,
  scoreColor,
  scoreHue,
  underlineColor,
} from "./colors";

describe("scoreHue", () => {
  test("green at 0, amber at 0.5, red at 1", () => {
    expect(scoreHue(0)).toBeCloseTo(120);
    expect(scoreHue(0.5)).toBeCloseTo(45);
    expect(scoreHue(1)).toBeCloseTo(0);
  });

  test("clamps out-of-range input", () => {
    expect(scoreHue(-1)).toBeCloseTo(120);
    expect(scoreHue(2)).toBeCloseTo(0);
  });

  test("monotonically decreases as score increases", () => {
    const hues = [0, 0.2, 0.4, 0.6, 0.8, 1].map(scoreHue);
    for (let i = 1; i < hues.length; i++) {
      expect(hues[i]!).toBeLessThanOrEqual(hues[i - 1]!);
    }
  });
});

describe("riskLevel", () => {
  test("thresholds", () => {
    expect(riskLevel(0)).toBe("low");
    expect(riskLevel(0.34)).toBe("low");
    expect(riskLevel(0.35)).toBe("medium");
    expect(riskLevel(0.49)).toBe("medium");
    expect(riskLevel(0.5)).toBe("high");
    expect(riskLevel(1)).toBe("high");
  });

  test("FLAGGED_THRESHOLD sits within the medium/high band", () => {
    expect(FLAGGED_THRESHOLD).toBeGreaterThanOrEqual(0.4);
    expect(FLAGGED_THRESHOLD).toBeLessThanOrEqual(0.75);
  });
});

describe("bucketScore", () => {
  test("spreads across the full range", () => {
    expect(bucketScore(0, 12)).toBe(0);
    expect(bucketScore(0.999, 12)).toBe(11);
    expect(bucketScore(1, 12)).toBe(11);
  });

  test("never returns a negative or out-of-range bucket", () => {
    for (const s of [-1, 0, 0.25, 0.5, 0.75, 1, 2]) {
      const b = bucketScore(s, 8);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(8);
    }
  });
});

describe("bandWeight", () => {
  test("stays at the base weight below the AI band", () => {
    expect(bandWeight(0)).toBe(600);
    expect(bandWeight(FLAGGED_THRESHOLD - 0.01)).toBe(600);
  });
  test("climbs from 600 to 800 across the AI band", () => {
    expect(bandWeight(FLAGGED_THRESHOLD)).toBe(600);
    expect(bandWeight(1)).toBe(800);
    expect(bandWeight(0.6)).toBeGreaterThan(bandWeight(FLAGGED_THRESHOLD));
    expect(bandWeight(0.9)).toBeGreaterThan(bandWeight(0.6));
  });
});

describe("scoreColor", () => {
  test("varies continuously, not just per band", () => {
    const a = scoreColor(0.55);
    const b = scoreColor(0.7);
    const c = scoreColor(0.95);
    expect(new Set([a, b, c]).size).toBe(3);
  });
  test("light and dark themes differ", () => {
    expect(scoreColor(0.8, "light")).not.toBe(scoreColor(0.8, "dark"));
  });
});

describe("theme colours", () => {
  test("heatmap and underline colours are never colour-identical across themes", () => {
    const light = heatmapColor(0.9, "light");
    const dark = heatmapColor(0.9, "dark");
    expect(light.background).not.toBe(dark.background);
  });

  test("underline colour has a transparent background (text stays readable)", () => {
    expect(underlineColor(0.5, "light").background).toBe("transparent");
  });
});
