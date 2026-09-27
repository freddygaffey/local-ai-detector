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
  // docs/calibration.md, T5 browser re-calibration (2026-09-27): the
  // extension itself (Chrome 153, ONNX Runtime Web, WASM q8) run over the 49
  // calibration texts + 595 held-out MAGE texts. Browser WASM does not
  // reproduce Node's numbers, and Firefox (WASM) matches Chrome WASM, so
  // these constants are for WASM. Each detector's 0.5 point is where ~5% of
  // the pooled human texts score higher (a deliberately low false-positive
  // operating point). Slopes are T1's: the logistic fit (~0.5) squeezed
  // almost every score into 0.3-0.6, which the UI's bands can't show.
  classifier: {
    classifier: { center: 3.84, slope: 1.27 },
    classifierLite: { center: 2.7, slope: 1.72 },
  },
  // Burstiness carried no signal (AUROC 0.51 in the first calibration), so
  // b = 0: only log-perplexity is used.
  perplexity: { tau: 3.17, a: 2.0, tauBurst: 0.58, b: 0 },
  // Binoculars always runs on WASM q8; still the Node-fitted constants
  // (experimental, not re-checked on the browser data).
  binoculars: { tau: 0.82, k: 10 },
  ensemble: { wClassifier: 0.7, wPerplexity: 0.3 },
};

/**
 * WebGPU runs different weights (q4f16 / fp16) and gives visibly different
 * raw outputs (docs/calibration.md, "WASM vs WebGPU"), so it gets its own
 * operating points, fitted the same way on the same texts.
 */
export const WEBGPU_CALIBRATION: Pick<Calibration, "classifier" | "perplexity"> = {
  classifier: {
    classifier: { center: 3.14, slope: 1.27 },
    classifierLite: { center: 1.91, slope: 1.72 },
  },
  perplexity: { tau: 2.93, a: 2.0, tauBurst: 0.58, b: 0 },
};

/** Constants for the device a model actually ran on. */
export function calibrationFor(device: string | undefined): Calibration {
  return device === "webgpu" ? { ...CALIBRATION, ...WEBGPU_CALIBRATION } : CALIBRATION;
}
