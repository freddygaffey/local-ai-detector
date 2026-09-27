// Defensive bridge to T7's calibrated-display additions to
// src/shared/thresholds.ts (owned by T7; see docs/plan.md coordination
// notes -- T9 must not edit that file). T7 is expected to add:
//   - `toDisplayProbability(score: number, ctx?: unknown): number` -- a
//     calibrated display probability, used everywhere a percent is shown.
//   - `MIN_WORDS_FOR_SCORE: number` -- below this word count, no number is
//     shown at all (see `formatScoreOrDash`).
//   - `filterThreshold` -- the slop filter's own threshold (distinct from
//     the display/flag threshold above); used by src/content/slopFilter.ts
//     and the chip's per-thread flagged count, never for display rounding.
// Until they land, this falls back to the raw score / sensible defaults, so
// every surface can use these names now and pick up T7's real calibration
// automatically once it ships, with no other code changes.

import * as thresholds from "../shared/thresholds";
import type { AnalyzeResult } from "../shared/messages";

type ThresholdsExtra = {
  toDisplayProbability?: (score: number, ctx?: unknown) => number;
  MIN_WORDS_FOR_SCORE?: number;
  filterThreshold?: number | (() => number);
};

function extra(): ThresholdsExtra {
  return thresholds as unknown as ThresholdsExtra;
}

/** 0..1 raw score -> 0..1 calibrated display probability. Pass-through until T7's version lands. */
export function displayProbability(score: number): number {
  const fn = extra().toDisplayProbability;
  return typeof fn === "function" ? fn(score) : score;
}

/**
 * The number to show for a whole analysis: T7's own calibrated
 * `result.probability` when present (undefined means "too short to score" --
 * see `MIN_WORDS_FOR_SCORE`), otherwise `displayProbability(overall)` for
 * results that predate that field (e.g. a per-block adapter score, or an
 * older stored result).
 */
export function displayScore(result: Pick<AnalyzeResult, "probability" | "overall">): number | null {
  if (result.probability !== undefined) return result.probability;
  return displayProbability(result.overall);
}

/** Word count below which a score isn't shown as a number at all (see formatScoreOrDash). */
export function minWordsForScore(fallback = 50): number {
  const n = extra().MIN_WORDS_FOR_SCORE;
  return typeof n === "number" ? n : fallback;
}

/** "—" when `words` is under the minimum, otherwise "NN%" of the calibrated display probability. */
export function formatScoreOrDash(score: number, words: number, fallbackMinWords = 50): string {
  if (words < minWordsForScore(fallbackMinWords)) return "—";
  return `${Math.round(displayProbability(score) * 100)}%`;
}

/** The slop filter's own action threshold (distinct from display rounding). */
export function filterThreshold(fallback = 0.6): number {
  const v = extra().filterThreshold;
  if (typeof v === "number") return v;
  if (typeof v === "function") return v();
  return fallback;
}
