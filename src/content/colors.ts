// Pure score -> colour mapping used by the three highlight styles
// (heatmap/flagged/underline). Kept dependency-free from the DOM so it can be
// unit tested directly (see colors.test.ts) and reused by highlightStyles.ts
// and the dev demo page.
//
// Accessibility: colour is never the *only* signal -- callers must also pair
// this with a text label (risk level / percentage) in tooltips and the pill.
// See riskLevel() below for that label.

import type { HighlightStyle } from "../shared/settings";

export type RiskLevel = "low" | "medium" | "high";
export type Theme = "light" | "dark";

/** Sentences scoring at/above this are "flagged" in Ctrl+F style mode. */
export const FLAGGED_THRESHOLD = 0.6;

/** Number of discrete colour buckets used for CSS Custom Highlight groups. */
export const COLOR_BUCKETS = 12;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Green (120°) at score 0, amber (45°) at 0.5, red (0°) at score 1. */
export function scoreHue(score: number): number {
  const s = clamp01(score);
  return s <= 0.5 ? 120 - (120 - 45) * (s / 0.5) : 45 - 45 * ((s - 0.5) / 0.5);
}

/** Coarse, human-readable risk label -- never rely on hue alone. */
export function riskLevel(score: number): RiskLevel {
  const s = clamp01(score);
  if (s >= 0.75) return "high";
  if (s >= 0.4) return "medium";
  return "low";
}

/** Buckets a 0..1 score into [0, buckets-1] for grouping into named highlights. */
export function bucketScore(score: number, buckets: number = COLOR_BUCKETS): number {
  const s = clamp01(score);
  return Math.min(buckets - 1, Math.floor(s * buckets));
}

export interface ThemeColor {
  background: string;
  text: string;
  decoration: string;
}

/** Full-saturation tint, low alpha -- every sentence gets one. */
export function heatmapColor(score: number, theme: Theme): ThemeColor {
  const hue = scoreHue(score);
  const alpha = theme === "dark" ? 0.32 : 0.24;
  return {
    background: `hsla(${hue.toFixed(1)}, 85%, ${theme === "dark" ? 42 : 55}%, ${alpha})`,
    text: theme === "dark" ? "#f5f5f5" : "#1a1a1a",
    decoration: `hsl(${hue.toFixed(1)}, 80%, ${theme === "dark" ? 62 : 38}%)`,
  };
}

/** Only rendered for score >= FLAGGED_THRESHOLD -- stronger, Ctrl+F-style tint. */
export function flaggedColor(score: number, theme: Theme): ThemeColor {
  const hue = scoreHue(score);
  const alpha = theme === "dark" ? 0.55 : 0.45;
  return {
    background: `hsla(${hue.toFixed(1)}, 90%, ${theme === "dark" ? 45 : 60}%, ${alpha})`,
    text: theme === "dark" ? "#111111" : "#1a1a1a",
    decoration: `hsl(${hue.toFixed(1)}, 85%, ${theme === "dark" ? 65 : 35}%)`,
  };
}

/** Transparent background, coloured wavy underline. */
export function underlineColor(score: number, theme: Theme): ThemeColor {
  const hue = scoreHue(score);
  return {
    background: "transparent",
    text: theme === "dark" ? "#f5f5f5" : "#1a1a1a",
    decoration: `hsl(${hue.toFixed(1)}, 85%, ${theme === "dark" ? 60 : 42}%)`,
  };
}

/** Muted/hatched styling for low-confidence (below settings.minWords) sentences. */
export function mutedAlpha(theme: Theme): number {
  return theme === "dark" ? 0.12 : 0.1;
}

/** In "flagged" style, only sentences at/above FLAGGED_THRESHOLD are rendered/hoverable. */
export function sentenceQualifies(style: HighlightStyle, score: number): boolean {
  return style !== "flagged" || score >= FLAGGED_THRESHOLD;
}
