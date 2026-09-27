// Calibration constants for mapping raw detector statistics to a 0..1 "AI
// likelihood". Picked with scripts/calibrate.mjs on a small hand-made sample
// (public-domain human text vs. AI-style text we wrote ourselves); see
// docs/calibration.md for the numbers and the (many) caveats. These are
// rough: treat scores as a relative signal, not a verdict.
//
// All logs are natural logs; log-perplexity = mean per-token NLL.

export interface Calibration {
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
  perplexity: { tau: 3.6, a: 2.0, tauBurst: 0.9, b: 1.0 },
  binoculars: { tau: 0.9, k: 12 },
  ensemble: { wClassifier: 0.6, wPerplexity: 0.4 },
};
