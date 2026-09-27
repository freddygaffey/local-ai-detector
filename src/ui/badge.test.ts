import { describe, expect, test } from "vitest";
import { badgeColorForScore, badgeTextForProgress, badgeTextForScore } from "./badge";

describe("badgeTextForProgress", () => {
  test("indeterminate shows just the spinner glyph", () => {
    expect(badgeTextForProgress(undefined, 0)).toHaveLength(1);
  });
  test("determinate appends a clamped percent", () => {
    expect(badgeTextForProgress(42, 0)).toMatch(/42$/);
    expect(badgeTextForProgress(150, 0)).toMatch(/99$/);
    expect(badgeTextForProgress(-5, 0)).toMatch(/0$/);
  });
  test("cycles frames without throwing", () => {
    for (let i = 0; i < 8; i++) expect(() => badgeTextForProgress(10, i)).not.toThrow();
  });
});

describe("badgeTextForScore", () => {
  test("formats as a bare integer percent", () => {
    expect(badgeTextForScore(0.42)).toBe("42");
    expect(badgeTextForScore(1)).toBe("100");
    expect(badgeTextForScore(0)).toBe("0");
  });
});

describe("badgeColorForScore", () => {
  test("colours differ across bands", () => {
    const human = badgeColorForScore(0.1);
    const mixed = badgeColorForScore(0.42);
    const ai = badgeColorForScore(0.9);
    expect(new Set([human, mixed, ai]).size).toBe(3);
  });

  test("colours differ within the AI band too (graduation, not a flat swatch)", () => {
    expect(badgeColorForScore(0.55)).not.toBe(badgeColorForScore(0.98));
  });

  test("always a concrete #rrggbb (browser badge APIs, not an hsl() string)", () => {
    expect(badgeColorForScore(0.5)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
