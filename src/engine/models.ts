// Model registry: the pinned, known-good default for every model slot, plus
// helpers to resolve the *active* {repo, revision} for a slot from settings.
//
// Every default is pinned to an exact Hugging Face commit SHA (looked up via
// https://huggingface.co/api/models/<repo> -> `sha` on 2026-09-27), so the
// files can't change underneath a release. "Check for updates" compares these
// against the repo's latest commit (see ./model-manager.ts).
//
// Licences: the onnx-community / Xenova conversion repos mostly carry no
// licence tag of their own. They are format conversions, so the upstream
// model's licence (recorded in `upstream`/`license` below) is authoritative.
// See docs/feasibility.md §8.
//
// Pure module (no browser APIs), so the popup/options UI may import it too,
// e.g. to show download sizes before the user consents.

import {
  DEFAULT_FUSION,
  DEFAULT_TIERS,
  type EnsembleClassifier,
  type FusionDetector,
  type FusionSettings,
  type Mode,
  type ModelRef,
  type ModelSlot,
  type Settings,
  type Tier,
  type TierSettings,
} from "../shared/settings";

/** transformers.js dtype identifiers we use. */
export type DType = "q8" | "q4f16" | "fp16" | "q4" | "fp32";

export type ModelTask = "text-classification" | "causal-lm";

export interface ModelSpec {
  slot: ModelSlot;
  /** Human-readable name for the UI. */
  label: string;
  repo: string;
  revision: string;
  task: ModelTask;
  /** SPDX-ish licence id of the weights (from the upstream card). */
  license: string;
  /** Upstream repo the ONNX files were converted from (licence source). */
  upstream: string;
  /** Base name of the ONNX file under onnx/ (transformers.js `model_file_name`). */
  modelFileName: string;
  /** dtype to use per device class. */
  dtypes: { wasm: DType; webgpuF16: DType };
  /**
   * Always run on WASM (q8), even when WebGPU is available. Set for the
   * Binoculars pair: their q4f16 WebGPU run gave uniform logits (every score
   * exactly 1.0) in Chrome 153 during T5 QA, and q8 is what was calibrated.
   */
  wasmOnly?: boolean;
  /** Approximate download size in bytes per dtype (onnx weights + tokenizer.json + configs). */
  sizes: Partial<Record<DType, number>>;
  /** Max sequence length the model accepts (tokens). */
  maxLength: number;
  /** Tokens per forward pass we use for sliding-window LM scoring. */
  window?: number;
  /** Tokens of left context re-used between consecutive LM windows. */
  overlap?: number;
}

const KB = 1024;

export const DEFAULT_MODELS: Record<ModelSlot, ModelSpec> = {
  classifier: {
    slot: "classifier",
    label: "TMR AI-text detector (RoBERTa-base, RAID)",
    repo: "onnx-community/tmr-ai-text-detector-ONNX",
    revision: "b9aa251e5bcda7e429fcc936767d921435945b60",
    task: "text-classification",
    license: "mit",
    upstream: "Oxidane/tmr-ai-text-detector",
    modelFileName: "model",
    // T7: fp16 on WebGPU; q4f16 ranked worse on the web eval set (AUROC 0.844 vs 0.861).
    dtypes: { wasm: "q8", webgpuF16: "fp16" },
    // onnx/model_quantized.onnx 125,855,418 B; model_fp16.onnx 249,618,877 B;
    // model_q4f16.onnx 127,536,080 B; tokenizer.json 3,558,741 B (+ small configs).
    sizes: {
      q8: 125_855_418 + 3_558_741 + 4 * KB,
      fp16: 249_618_877 + 3_558_741 + 4 * KB,
      q4f16: 127_536_080 + 3_558_741 + 4 * KB,
    },
    maxLength: 512,
  },
  classifierLite: {
    slot: "classifierLite",
    label: "e5-small LoRA AI-text detector (lite)",
    repo: "onnx-community/e5-small-lora-ai-generated-detector-ONNX",
    revision: "02919a911bb647ceac84de99afb00ea2da8c2725",
    task: "text-classification",
    license: "mit",
    upstream: "MayZhou/e5-small-lora-ai-generated-detector",
    modelFileName: "model",
    // T7: fp16 on WebGPU; q4f16 ranked worse (AUROC 0.735 vs 0.756).
    dtypes: { wasm: "q8", webgpuF16: "fp16" },
    // onnx/model_quantized.onnx 34,157,539 B; model_fp16.onnx 67,030,154 B;
    // model_q4f16.onnx 36,517,437 B; tokenizer.json 711,396 B.
    sizes: {
      q8: 34_157_539 + 711_396 + 4 * KB,
      fp16: 67_030_154 + 711_396 + 4 * KB,
      q4f16: 36_517_437 + 711_396 + 4 * KB,
    },
    maxLength: 512,
  },
  classifierModernBert: {
    slot: "classifierModernBert",
    label: "ModernBERT AI-text detector (RAID + MAGE)",
    repo: "onnx-community/modernbert-ai-detection-raid-mage-ONNX",
    revision: "6dcd8a3100e75d1224d7222d883bde596113d3f3",
    task: "text-classification",
    license: "apache-2.0",
    upstream: "GeorgeDrayson/modernbert-ai-detection-raid-mage",
    modelFileName: "model",
    dtypes: { wasm: "q8", webgpuF16: "fp32" },
    // T7: on WebGPU (Chrome 153, ORT-web 1.31 dev) its fp16 and q4f16
    // weights give one constant output for every input, like Binoculars'.
    // fp32 works but is a 599 MB download, so it runs on WASM q8.
    wasmOnly: true,
    // onnx/model_quantized.onnx 150,872,643 B; model_fp16.onnx 299,594,984 B;
    // model_q4f16.onnx 140,208,329 B; tokenizer.json 3,583,228 B.
    sizes: {
      q8: 150_872_643 + 3_583_228 + 24 * KB,
      fp16: 299_594_984 + 3_583_228 + 24 * KB,
      q4f16: 140_208_329 + 3_583_228 + 24 * KB,
    },
    maxLength: 512,
  },
  classifierFakespot: {
    slot: "classifierFakespot",
    label: "Fakespot AI-text detector (RoBERTa-base)",
    // A faithful INT8 ONNX export of fakespot-ai/roberta-base-ai-text-detection-v1
    // (Apache-2.0; checked against our own optimum export, docs/calibration.md).
    // Upstream publishes safetensors only.
    repo: "amankrai28/fakespot-roberta-ai-detector-onnx",
    revision: "403ab9033c9502455cfb7f58e50e65620b422cec",
    task: "text-classification",
    license: "apache-2.0",
    upstream: "fakespot-ai/roberta-base-ai-text-detection-v1",
    modelFileName: "model",
    // Only q8 weights exist in this repo. int8 MatMul has no WebGPU kernel, so
    // on WebGPU it ran no faster and ranked worse (AUROC 0.907 vs 0.932 on
    // WASM): it always runs on WASM.
    dtypes: { wasm: "q8", webgpuF16: "q8" },
    wasmOnly: true,
    // onnx/model_quantized.onnx 125,465,750 B; tokenizer.json 3,558,896 B (+ vocab/merges/configs).
    sizes: { q8: 125_465_750 + 3_558_896 + 1_260 * KB },
    maxLength: 512,
  },
  perplexityLM: {
    slot: "perplexityLM",
    label: "DistilGPT-2 (perplexity)",
    repo: "Xenova/distilgpt2",
    revision: "a41c10485c18a64b6606729b6a082330cbd8f49e",
    task: "causal-lm",
    license: "apache-2.0",
    upstream: "distilbert/distilgpt2",
    // That repo's plain model_quantized.onnx is 237 MB and barely compressed;
    // the merged decoder q8 is 85 MB (docs/feasibility.md §2, mode 2).
    modelFileName: "decoder_model_merged",
    // q4f16 of this repo is not smaller than fp16, so use fp16 on WebGPU.
    dtypes: { wasm: "q8", webgpuF16: "fp16" },
    // decoder_model_merged_quantized.onnx 84,911,479 B; _fp16 165,293,231 B; tokenizer.json 2,107,653 B.
    sizes: { q8: 84_911_479 + 2_107_653 + 4 * KB, fp16: 165_293_231 + 2_107_653 + 4 * KB },
    maxLength: 1024,
    // A 512-token window keeps the logits buffer at ~100 MB (512 x 50257 x 4 B).
    window: 512,
    overlap: 128,
  },
  binocularsObserver: {
    slot: "binocularsObserver",
    label: "SmolLM2-135M (Binoculars observer)",
    repo: "onnx-community/SmolLM2-135M-ONNX",
    revision: "d0ae6834f1df45e0e95b5fdae95e536f9ca7cd3f",
    task: "causal-lm",
    license: "apache-2.0",
    upstream: "HuggingFaceTB/SmolLM2-135M",
    modelFileName: "model",
    dtypes: { wasm: "q8", webgpuF16: "q8" },
    wasmOnly: true,
    // model_quantized.onnx + .onnx_data = 1,252,724 + 136,717,568 B;
    // model_q4f16.onnx + .onnx_data = 276,492 + 117,461,632 B; tokenizer.json 2,053,526 B.
    sizes: {
      q8: 1_252_724 + 136_717_568 + 2_053_526 + 8 * KB,
      q4f16: 276_492 + 117_461_632 + 2_053_526 + 8 * KB,
    },
    maxLength: 8192,
    window: 384,
    overlap: 64,
  },
  binocularsPerformer: {
    slot: "binocularsPerformer",
    label: "SmolLM2-135M-Instruct (Binoculars performer)",
    repo: "onnx-community/SmolLM2-135M-Instruct-ONNX",
    revision: "b8a5c0f183b78c55955a5364f610c36668b5e681",
    task: "causal-lm",
    license: "apache-2.0",
    upstream: "HuggingFaceTB/SmolLM2-135M-Instruct",
    modelFileName: "model",
    dtypes: { wasm: "q8", webgpuF16: "q8" },
    wasmOnly: true,
    // model_quantized.onnx 135,658,354 B; model_q4f16.onnx 117,266,133 B; tokenizer.json 3,522,656 B.
    sizes: {
      q8: 135_658_354 + 3_522_656 + 8 * KB,
      q4f16: 117_266_133 + 3_522_656 + 8 * KB,
    },
    maxLength: 8192,
    window: 384,
    overlap: 64,
  },
};

export const MODEL_SLOTS = Object.keys(DEFAULT_MODELS) as ModelSlot[];

/** Model slots each Fusion detector needs. */
export const DETECTOR_SLOTS: Record<FusionDetector, ModelSlot[]> = {
  fakespot: ["classifierFakespot"],
  tmr: ["classifier"],
  lite: ["classifierLite"],
  modernbert: ["classifierModernBert"],
  perplexity: ["perplexityLM"],
  binoculars: ["binocularsObserver", "binocularsPerformer"],
};

/** Short UI labels per detector. */
export const DETECTOR_LABELS: Record<FusionDetector, string> = {
  fakespot: "Fakespot",
  tmr: "TMR",
  lite: "Lite (e5)",
  modernbert: "ModernBERT",
  perplexity: "Perplexity",
  binoculars: "Binoculars",
};

/**
 * What an "ensemble" (Fusion) run uses: a FusionSettings, or (legacy
 * callers) the v1 `ensembleClassifier`, which meant "that classifier +
 * perplexity". Undefined means the default Fusion set.
 */
export type FusionSpec = FusionSettings | EnsembleClassifier | undefined;

export function fusionFrom(spec: FusionSpec): FusionSettings {
  if (spec === undefined) return DEFAULT_FUSION;
  if (typeof spec === "string") {
    return { detectors: [spec === "classifierLite" ? "lite" : "tmr", "perplexity"], method: "weighted" };
  }
  return spec.detectors.length ? spec : DEFAULT_FUSION;
}

/** The detectors a mode runs, in a fixed order, and how they are combined. */
export function detectorsForMode(mode: Mode, fusion?: FusionSpec): FusionSettings {
  switch (mode) {
    case "classifier":
      return { detectors: ["tmr"], method: "weighted" };
    case "classifierLite":
      return { detectors: ["lite"], method: "weighted" };
    case "perplexity":
      return { detectors: ["perplexity"], method: "weighted" };
    case "binoculars":
      return { detectors: ["binoculars"], method: "weighted" };
    case "ensemble":
    default: {
      const f = fusionFrom(fusion);
      const order: FusionDetector[] = ["fakespot", "tmr", "modernbert", "lite", "perplexity", "binoculars"];
      return { detectors: order.filter((d) => f.detectors.includes(d)), method: f.method };
    }
  }
}

/** Which slots each detector mode needs loaded. */
export function slotsForMode(mode: Mode, fusion?: FusionSpec): ModelSlot[] {
  return detectorsForMode(mode, fusion).detectors.flatMap((d) => DETECTOR_SLOTS[d]);
}

/**
 * The Fusion detector set for a tier (docs/plan.md "Two tiers: Quick
 * (default) and Deep (on demand)"): Quick's cheap automatic pass, or Deep's
 * on-demand "run everything" pass. Combined by weighted average, like the
 * default Fusion -- Quick/Deep only choose *which* detectors run, not how
 * they are combined. Falls back to the tier's own default if the settings
 * value was sanitized down to nothing.
 */
export function fusionForTier(tier: Tier, tiers: TierSettings): FusionSettings {
  const detectors = tier === "deep" ? tiers.deepDetectors : tiers.quickDetectors;
  const fallback = tier === "deep" ? DEFAULT_TIERS.deepDetectors : DEFAULT_TIERS.quickDetectors;
  return { detectors: detectors.length ? detectors : fallback, method: "weighted" };
}

export interface ActiveModel extends ModelRef {
  slot: ModelSlot;
  /** True when this is the pinned default repo *and* revision. */
  isDefault: boolean;
  /** True when the repo is the default repo (possibly a newer revision). */
  isDefaultRepo: boolean;
  spec: ModelSpec;
  previous?: ModelRef;
}

/** The {repo, revision} a slot should use: `settings.modelOverrides[slot] ?? default`. */
export function activeModel(
  slot: ModelSlot,
  overrides: Settings["modelOverrides"] | undefined,
): ActiveModel {
  const spec = DEFAULT_MODELS[slot];
  const o = overrides?.[slot];
  const repo = o?.repo || spec.repo;
  const revision = o?.revision || spec.revision;
  return {
    slot,
    repo,
    revision,
    isDefault: repo === spec.repo && revision === spec.revision,
    isDefaultRepo: repo === spec.repo,
    spec,
    previous: o?.previous,
  };
}

/** Active refs for every slot a mode needs. */
export function activeModelsForMode(
  mode: Mode,
  overrides: Settings["modelOverrides"] | undefined,
  fusion?: FusionSpec,
): Partial<Record<ModelSlot, ModelRef>> {
  const out: Partial<Record<ModelSlot, ModelRef>> = {};
  for (const slot of slotsForMode(mode, fusion)) {
    const a = activeModel(slot, overrides);
    out[slot] = { repo: a.repo, revision: a.revision };
  }
  return out;
}

/**
 * Approximate first-run download for a mode, in bytes, for the pinned
 * defaults. `device` picks the dtype column (WASM q8 unless WebGPU with
 * shader-f16). Returns null for slots overridden to a custom repo (unknown).
 */
export function estimatedDownloadBytes(
  mode: Mode,
  device: "wasm" | "webgpu-f16" = "wasm",
  overrides?: Settings["modelOverrides"],
  fusion?: FusionSpec,
): number | null {
  let total = 0;
  for (const slot of slotsForMode(mode, fusion)) {
    const a = activeModel(slot, overrides);
    if (!a.isDefaultRepo) return null;
    const dtype = device === "webgpu-f16" && !a.spec.wasmOnly ? a.spec.dtypes.webgpuF16 : a.spec.dtypes.wasm;
    total += a.spec.sizes[dtype] ?? 0;
  }
  return total;
}

/** Suffix transformers.js appends to the ONNX file base name per dtype. */
export const DTYPE_SUFFIX: Record<DType, string> = {
  fp32: "",
  fp16: "_fp16",
  q8: "_quantized",
  q4: "_q4",
  q4f16: "_q4f16",
};

/**
 * Licences we consider "open" for the custom-model warning. Anything else
 * (including no licence at all) gets a visible warning in the UI; it is not
 * blocked, since the user chose it.
 */
export const OPEN_LICENSES = new Set([
  "mit",
  "apache-2.0",
  "bsd",
  "bsd-2-clause",
  "bsd-3-clause",
  "isc",
  "cc0-1.0",
  "cc-by-4.0",
  "cc-by-3.0",
  "unlicense",
  "mpl-2.0",
  "zlib",
  "openrail",
  "bigscience-openrail-m",
  "creativeml-openrail-m",
  "openrail++",
]);

export function isOpenLicense(license: string | null | undefined): boolean {
  if (!license) return false;
  return OPEN_LICENSES.has(license.toLowerCase());
}

/** Which kind of model each slot needs (used to validate custom repos). */
export function slotTask(slot: ModelSlot): ModelTask {
  return DEFAULT_MODELS[slot].task;
}

/** Cache-key prefix transformers.js uses for files of `ref` (Cache API / our IDB cache). */
export function cachePrefix(ref: ModelRef, remoteHost = "https://huggingface.co/"): string {
  return `${remoteHost}${ref.repo}/resolve/${encodeURIComponent(ref.revision)}/`;
}

export function sameRef(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return !!a && !!b && a.repo === b.repo && a.revision === b.revision;
}

export function refKey(ref: ModelRef): string {
  return `${ref.repo}@${ref.revision}`;
}

/**
 * Measured warm analysis time per ~1,000 words, in ms, per detector and
 * device (Chrome 153, Apple Silicon; docs/qa.md "Timings"). Rough: slower
 * machines take several times longer. Firefox WASM is single-threaded,
 * about 2.5x the WASM figure.
 */
export const DETECTOR_SPEED_MS_PER_1K_WORDS: Record<FusionDetector, { webgpu: number; wasm: number }> = {
  // T7 browser runs (Chrome 153, Apple M-series, 4 WASM threads), rounded up.
  // WASM-only detectors cost the same on either path.
  fakespot: { webgpu: 2500, wasm: 2500 },
  tmr: { webgpu: 400, wasm: 2500 },
  lite: { webgpu: 200, wasm: 800 },
  modernbert: { webgpu: 3500, wasm: 3500 },
  perplexity: { webgpu: 750, wasm: 2000 },
  binoculars: { webgpu: 20000, wasm: 20000 },
};

export interface FusionEstimate {
  /** First-run download for the chosen set (pinned defaults), or null if a slot uses a custom repo. */
  bytes: number | null;
  /** Rough warm time for a ~1,000-word page, in ms. */
  msPer1kWords: number;
  /** Slots that would run on WASM even with WebGPU (e.g. Binoculars). */
  wasmOnly: ModelSlot[];
}

/** Download size and speed estimate for a Fusion detector set on a device. */
export function estimateFusion(
  detectors: readonly FusionDetector[],
  device: "webgpu" | "wasm",
  overrides?: Settings["modelOverrides"],
): FusionEstimate {
  let bytes: number | null = 0;
  let ms = 0;
  const wasmOnly: ModelSlot[] = [];
  for (const d of new Set(detectors)) {
    ms += DETECTOR_SPEED_MS_PER_1K_WORDS[d][device];
    for (const slot of DETECTOR_SLOTS[d]) {
      const a = activeModel(slot, overrides);
      if (a.spec.wasmOnly) wasmOnly.push(slot);
      if (!a.isDefaultRepo || bytes === null) {
        bytes = null;
        continue;
      }
      const dtype = device === "webgpu" && !a.spec.wasmOnly ? a.spec.dtypes.webgpuF16 : a.spec.dtypes.wasm;
      bytes += a.spec.sizes[dtype] ?? 0;
    }
  }
  return { bytes, msPer1kWords: ms, wasmOnly };
}
