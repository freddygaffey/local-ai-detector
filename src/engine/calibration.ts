// Calibration constants for mapping raw detector statistics to the engine's
// 0..1 score scale, per device. On this scale each detector's 0.5 sits where
// about 5% of human texts score higher (a deliberately low false-positive
// operating point; src/shared/thresholds.ts). The display probability shown
// to users ("AI 91%") is a separate, fitted mapping of this score
// (src/shared/displayCalibration.ts).
//
// T7 (2026-09-27): WebGPU is the primary path and its constants are the
// main ones; the WASM constants are the fallback (Firefox on Linux, no
// adapter, no shader-f16). Both were fitted in the browser on the T7
// web-genre eval set's "fit" half (scripts/e2e/browser-t7-calibration.mjs);
// see docs/calibration.md for data, numbers and caveats.
//
// All logs are natural logs; log-perplexity = mean per-token NLL.

import type { FusionDetector } from "../shared/settings";

export type ClassifierSlot = "classifier" | "classifierLite" | "classifierModernBert" | "classifierFakespot";

export interface LogitMap {
  /** p' = sigmoid(slope * (logit(p) - center)) */
  center: number;
  slope: number;
}

export interface Calibration {
  /**
   * Logit-space recalibration of a pinned classifier's raw AI probability.
   * Only applied to the default repos (custom models keep their own scale).
   */
  classifier: Partial<Record<ClassifierSlot, LogitMap>>;
  perplexity: {
    /** log-PPL at which the perplexity term is 0.5 (distilgpt2). */
    tau: number;
    /** Slope per nat of log-PPL. */
    a: number;
    /** Burstiness (std-dev of sentence log-PPL) at which that term is neutral. */
    tauBurst: number;
    /** Slope per nat of burstiness (0: carried no signal). */
    b: number;
  };
  binoculars: {
    /** Binoculars score (logPPL / cross-entropy) at which p = 0.5. */
    tau: number;
    k: number;
  };
  /** v1 two-detector ensemble weights (kept for `blendEnsemble`). */
  ensemble: { wClassifier: number; wPerplexity: number };
  /** Fusion "weighted" method: per-detector weights (renormalised over the chosen set). */
  fusionWeights: Record<FusionDetector, number>;
  /**
   * Paragraph-level operating points for sentence colours / "flagged" (a
   * paragraph is shorter and noisier than a document). Slopes are shared.
   */
  unit: {
    classifier: Partial<Record<ClassifierSlot, LogitMap>>;
    perplexityTau: number;
    /** Paragraph-level perplexity slope (default: perplexity.a). */
    perplexityA?: number;
    binocularsTau: number;
    /** Paragraph-level Binoculars slope (default: binoculars.k). */
    binocularsK?: number;
  };
}

/** WASM (q8) — the fallback path. Also used for Node (CPU) scripts. */
export const WASM_CALIBRATION: Calibration = {
  classifier: {
    classifier: { center: 3.84, slope: 1.27 },
    classifierLite: { center: 2.7, slope: 1.72 },
    classifierModernBert: { center: 3.0, slope: 1.0 },
    classifierFakespot: { center: 3.0, slope: 1.0 },
  },
  perplexity: { tau: 3.17, a: 2.0, tauBurst: 0.58, b: 0 },
  binoculars: { tau: 0.82, k: 10 },
  ensemble: { wClassifier: 0.7, wPerplexity: 0.3 },
  fusionWeights: { fakespot: 1, tmr: 1, lite: 1, modernbert: 1, perplexity: 0.5, binoculars: 0.5 },
  unit: {
    classifier: {
      classifier: { center: 4.2, slope: 1.27 },
      classifierLite: { center: 2.34, slope: 1.72 },
      classifierModernBert: { center: 3.0, slope: 1.0 },
    classifierFakespot: { center: 3.0, slope: 1.0 },
    },
    perplexityTau: 3.02,
    binocularsTau: 0.82,
  },
};

/** WebGPU (fp16 / q4f16 per model, see models.ts) — the primary path. */
export const WEBGPU_CALIBRATION: Calibration = {
  classifier: {
    classifier: { center: 3.14, slope: 1.27 },
    classifierLite: { center: 1.91, slope: 1.72 },
    classifierModernBert: { center: 3.0, slope: 1.0 },
    classifierFakespot: { center: 3.0, slope: 1.0 },
  },
  perplexity: { tau: 2.93, a: 2.0, tauBurst: 0.58, b: 0 },
  binoculars: { tau: 0.82, k: 10 },
  ensemble: { wClassifier: 0.7, wPerplexity: 0.3 },
  fusionWeights: { fakespot: 1, tmr: 1, lite: 1, modernbert: 1, perplexity: 0.5, binoculars: 0.5 },
  unit: {
    classifier: {
      classifier: { center: 3.87, slope: 1.27 },
      classifierLite: { center: 2.22, slope: 1.72 },
      classifierModernBert: { center: 3.0, slope: 1.0 },
    classifierFakespot: { center: 3.0, slope: 1.0 },
    },
    perplexityTau: 2.81,
    binocularsTau: 0.82,
  },
};

/** Back-compat name for the CPU/WASM constants (Node scripts, tests). */
export const CALIBRATION = WASM_CALIBRATION;

/** Constants for the device a model actually ran on. */
export function calibrationFor(device: string | undefined): Calibration {
  return device === "webgpu" ? WEBGPU_CALIBRATION : WASM_CALIBRATION;
}
