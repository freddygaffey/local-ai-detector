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

/**
 * WASM (q8) — the fallback path (Firefox on Linux, no adapter, no
 * shader-f16), and the device Fakespot, ModernBERT and Binoculars always run
 * on. Fitted on the CI browser run (.github/workflows/t7-eval.yml). Also used
 * by the Node (CPU) scripts.
 */
export const WASM_CALIBRATION: Calibration = {
  classifier: {
    classifierFakespot: {
      center: 3.525,
      slope: 0.489,
    },
    classifier: {
      center: 4.217,
      slope: 6,
    },
    classifierLite: {
      center: 2.327,
      slope: 2.943,
    },
    classifierModernBert: {
      center: 4.429,
      slope: 2.374,
    },
  },
  perplexity: {
    tau: 3.097,
    a: 1.043,
    tauBurst: 0.58,
    b: 0,
  },
  binoculars: {
    tau: 0.81,
    k: 6,
  },
  ensemble: {
    wClassifier: 0.7,
    wPerplexity: 0.3,
  },
  fusionWeights: {
    fakespot: 0.644,
    tmr: 0.093,
    lite: 0.049,
    modernbert: 0.083,
    perplexity: 0.049,
    binoculars: 1,
  },
  unit: {
    classifier: {
      classifierFakespot: {
        center: 4.483,
        slope: 0.525,
      },
      classifier: {
        center: 4.232,
        slope: 6,
      },
      classifierLite: {
        center: 2.352,
        slope: 5.164,
      },
      classifierModernBert: {
        center: 4.365,
        slope: 2.273,
      },
    },
    perplexityTau: 2.81,
    perplexityA: 0.475,
    binocularsTau: 0.774,
    binocularsK: 6,
  },
};

/**
 * WebGPU — the primary path (TMR and lite fp16, perplexity fp16; the
 * WASM-only detectors keep their WASM constants). Fitted on the local
 * Chrome 153 WebGPU run.
 */
export const WEBGPU_CALIBRATION: Calibration = {
  classifier: {
    classifierFakespot: {
      center: 3.525,
      slope: 0.489,
    },
    classifier: {
      center: 4.195,
      slope: 6,
    },
    classifierLite: {
      center: 2.481,
      slope: 3.309,
    },
    classifierModernBert: {
      center: 4.429,
      slope: 2.374,
    },
  },
  perplexity: {
    tau: 2.901,
    a: 1.155,
    tauBurst: 0.58,
    b: 0,
  },
  binoculars: {
    tau: 0.81,
    k: 6,
  },
  ensemble: {
    wClassifier: 0.7,
    wPerplexity: 0.3,
  },
  fusionWeights: {
    fakespot: 0.656,
    tmr: 0.096,
    lite: 0.049,
    modernbert: 0.076,
    perplexity: 0.049,
    binoculars: 1,
  },
  unit: {
    classifier: {
      classifierFakespot: {
        center: 4.483,
        slope: 0.525,
      },
      classifier: {
        center: 4.223,
        slope: 6,
      },
      classifierLite: {
        center: 2.551,
        slope: 5.022,
      },
      classifierModernBert: {
        center: 4.365,
        slope: 2.273,
      },
    },
    perplexityTau: 2.644,
    perplexityA: 0.494,
    binocularsTau: 0.774,
    binocularsK: 6,
  },
};

/** Back-compat name for the CPU/WASM constants (Node scripts, tests). */
export const CALIBRATION = WASM_CALIBRATION;

/** Constants for the device a model actually ran on. */
export function calibrationFor(device: string | undefined): Calibration {
  return device === "webgpu" ? WEBGPU_CALIBRATION : WASM_CALIBRATION;
}
