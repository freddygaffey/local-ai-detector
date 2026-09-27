// Score thresholds shared by the page (pill count, "Flagged only" style,
// ▲/▼ navigation, risk labels) and the popup (verdict band, "Flagged
// sentences"), so both always agree.
//
// Meaning of the scale (docs/calibration.md, "What ships"): each detector's
// 0.5 is placed where about 5% of the human texts in our calibration data
// score higher. So ">= 0.5" reads "scored higher than ~95% of the human
// texts we tested", not "50% probability of AI".

/** A sentence is "flagged" (and the page verdict says "likely AI patterns") at or above this. */
export const FLAGGED_THRESHOLD = 0.5;

/** Below this the verdict says "likely human-written patterns". */
export const HUMAN_MAX = 0.35;

// ---- Added by T7: slop-filter threshold, calibrated display probability ----

import { DISPLAY_CURVES, DISPLAY_FIT, type DisplayCurve } from "./displayCalibration";

/**
 * The slop filter (dim / collapse) acts only at or above this score: a
 * stricter operating point than FLAGGED_THRESHOLD, because hiding a real
 * person's comment is worse than missing some AI text. Fitted to about
 * 1% human false positives on the web eval set (docs/calibration.md).
 */
export const FILTER_THRESHOLD = DISPLAY_FIT.filterThreshold;
/** Alias under the name the plan uses. */
export const filterThreshold = FILTER_THRESHOLD;

/**
 * Below this many analysed words the UI shows "—" instead of a number: on
 * shorter text the detectors' scores stop tracking the truth (their
 * calibration error on the eval set climbs steeply; docs/calibration.md).
 */
export const MIN_WORDS_FOR_SCORE = DISPLAY_FIT.minWordsForScore;

/** Text is "short" (its own calibration curve) below this many words. */
export const SHORT_TEXT_WORDS = DISPLAY_FIT.shortTextWords;

export interface DisplayContext {
  /** Detectors that ran (order doesn't matter). Default: the default Fusion set. */
  detectors?: readonly string[];
  method?: string;
  device?: string;
  /** Words analysed; picks the short- or long-text curve. */
  words?: number;
  /**
   * "unit": the score is one item's paragraph-level score (a comment,
   * review or post on a thread page: `SentenceScore.score` averaged over the
   * item), which uses the paragraph operating points and has its own curve.
   */
  level?: "doc" | "unit";
}

function curveKey(ctx: DisplayContext): string {
  if (!ctx.detectors?.length) return DISPLAY_FIT.defaultProfile;
  const dets = [...ctx.detectors].sort().join("+");
  return ctx.detectors.length === 1 ? dets : `${dets}|${ctx.method ?? "weighted"}`;
}

function interp(curve: DisplayCurve, x: number): number {
  const xs = curve.x;
  const ys = curve.y;
  if (x <= xs[0]!) return ys[0]!;
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]!) {
      const t = (x - xs[i - 1]!) / (xs[i]! - xs[i - 1]! || 1);
      return ys[i - 1]! + t * (ys[i]! - ys[i - 1]!);
    }
  }
  return ys[ys.length - 1]!;
}

/**
 * Engine score (0..1, 0.5 = ~5% human FPR point) -> calibrated probability
 * that the text is AI-generated, for display ("AI 91%"). Fitted (isotonic,
 * on held-out web text with a 50/50 human/AI mix) per detector set, device
 * and text length; falls back to the default Fusion curve, then to a pooled
 * curve. Prefer `AnalyzeResult.probability`, which the engine computes with
 * the exact context.
 */
export function toDisplayProbability(score: number, ctx: DisplayContext = {}): number {
  if (!Number.isFinite(score)) return Number.NaN;
  const docLen = (ctx.words ?? SHORT_TEXT_WORDS) < SHORT_TEXT_WORDS ? "short" : "long";
  const len = ctx.level === "unit" ? "unit" : docLen;
  // "mixed" = the WebGPU path with a WASM-only detector (ModernBERT, Binoculars): WebGPU curves.
  const dev = ctx.device === "wasm" || ctx.device === "cpu" ? "wasm" : "webgpu";
  const key = curveKey(ctx);
  const c =
    DISPLAY_CURVES[`${key}|${dev}|${len}`] ??
    DISPLAY_CURVES[`${key}|webgpu|${len}`] ??
    DISPLAY_CURVES[`${DISPLAY_FIT.defaultProfile}|${dev}|${len}`] ??
    DISPLAY_CURVES[`pooled|${dev}|${len}`] ??
    DISPLAY_CURVES[`pooled|${dev}|short`];
  if (!c) return score;
  return Math.min(0.99, Math.max(0.01, interp(c, score)));
}

// ---- Quick tier confirmation (QA pass, docs/calibration.md "Quick tier and false positives") ----

/**
 * A Quick result at or above this shown P(AI) is re-checked with the default
 * Fusion set before anything is shown: the cheap pass alone put >= 50% on
 * 16% of human web texts (Fusion: 12%, and 6% -> 3% of pages reach the
 * chip), and on news it was the difference between "AI 77%" and "47%".
 */
export const QUICK_CONFIRM_AT = 0.5;

/** Whether a Quick result should be confirmed: AI-leaning overall, or any item past the slop-filter threshold. */
export function needsQuickConfirm(result: { probability?: number; sentences: { score: number }[] }): boolean {
  if ((result.probability ?? 0) >= QUICK_CONFIRM_AT) return true;
  return result.sentences.some((s) => s.score >= FILTER_THRESHOLD);
}
