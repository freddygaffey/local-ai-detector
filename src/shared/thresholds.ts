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
