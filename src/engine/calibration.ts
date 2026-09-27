// Calibration constants for mapping raw detector statistics to a 0..1 "AI
// likelihood". Picked with scripts/calibrate.mjs on a small hand-made sample
// (public-domain human text vs. AI-style text we wrote ourselves); see
// docs/calibration.md for the numbers and the (many) caveats. These are
// rough: treat scores as a relative signal, not a verdict.
//
// All logs are natural logs; log-perplexity = mean per-token NLL.

export interface Calibration {
  /**
   * Optional logit-space recalibration of a pinned classifier's raw AI
   * probability: p' = sigmoid(slope * (logit(p) - center)). Only applied to
   * the default repos (custom models keep their own scale).
   */
  classifier: Partial<Record<"classifier" | "classifierLite", { center: number; slope: number }>>;
  perplexity: {
    /** log-PPL at which the perplexity term is 0.5 (distilgpt2, q8). */
    tau: number;
    /** Slope per nat of log-PPL. */
    a: number;
    /** Burstiness (std-dev of sentence log-PPL) at which that term is neutral. */
    tauBurst: number;
    /** Slope per nat of burstiness. */
    b: number;
  };
  binoculars: {
    /** Binoculars score (logPPL / cross-entropy) at which p = 0.5. */
    tau: number;
    /** Slope. */
    k: number;
  };
  ensemble: {
    wClassifier: number;
    wPerplexity: number;
  };
}

export const CALIBRATION: Calibration = {
  // docs/calibration.md, 2026-09-27 run (49 texts: 28 human, 21 AI).
  // TMR's raw output is saturated (modern human prose scores ~0.98 too), so
  // it is re-centred at logit 3.96 (raw p ~0.981). The lite model is barely
  // changed.
  classifier: {
    classifier: { center: 3.96, slope: 1.27 },
    classifierLite: { center: 0.76, slope: 1.72 },
  },
  // Burstiness carried no signal on this sample (AUROC 0.51), so b = 0: only
  // log-perplexity is used. Kept in the formula for future calibration.
  perplexity: { tau: 3.5, a: 2.0, tauBurst: 0.58, b: 0 },
  binoculars: { tau: 0.82, k: 10 },
  ensemble: { wClassifier: 0.7, wPerplexity: 0.3 },
};
