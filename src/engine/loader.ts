// Loads (and memoizes) tokenizers + ONNX sessions per {repo, revision},
// reporting download progress. Sessions are kept warm until the slot's active
// model changes or `unloadModels` is called.

import {
  AutoConfig,
  AutoModelForCausalLM,
  AutoModelForSequenceClassification,
  AutoTokenizer,
  Tensor,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type ProgressInfo,
} from "@huggingface/transformers";
import type { ModelRef, ModelSlot } from "../shared/settings";
import { cachePrefix, DEFAULT_MODELS, DTYPE_SUFFIX, refKey, type DType, type ModelSpec } from "./models";
import { deviceAndDtype, disableWebGPU, getRuntimeInfo, modelCache } from "./runtime";
import { aiLabelIndex, type ForwardFn } from "./scoring";

export interface LoadedClassifier {
  kind: "classifier";
  ref: ModelRef;
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
  aiIndex: number;
  maxLength: number;
  device: string;
  dtype: DType;
}

export interface LoadedLM {
  kind: "lm";
  ref: ModelRef;
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
  /** Token prepended so the first real token gets scored (null if none). */
  bos: number | null;
  vocab: number;
  window: number;
  overlap: number;
  forward: ForwardFn;
  device: string;
  dtype: DType;
}

export type LoadedModel = LoadedClassifier | LoadedLM;

/** Raw per-file download progress, aggregated by the caller. */
export type FileProgress = (info: { key: string; file: string; loaded: number; total: number; done?: boolean }) => void;

const loaded = new Map<string, Promise<LoadedModel>>();

function memoKey(slot: ModelSlot, ref: ModelRef, dtype?: DType): string {
  return `${DEFAULT_MODELS[slot].task}|${refKey(ref)}${dtype ? `#${dtype}` : ""}`;
}

/** Candidate ONNX base names to try for a slot/ref (custom repos vary). */
function fileCandidates(spec: ModelSpec, ref: ModelRef): string[] {
  const c = ref.repo === spec.repo ? [spec.modelFileName] : [];
  const extra = spec.task === "causal-lm" ? ["model", "decoder_model_merged"] : ["model"];
  return [...new Set([...c, ...extra])];
}

function isMissingFileError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /could not locate file|404|not found|ModelFileNotFound/i.test(msg) ||
    (e as { name?: string })?.name === "ModelFileNotFoundError";
}

/**
 * `webgpuDtype` (calibration/dev builds only) replaces the slot's WebGPU
 * dtype and lets a WASM-only slot try WebGPU with it.
 */
export function loadModel(
  slot: ModelSlot,
  ref: ModelRef,
  onProgress?: FileProgress,
  webgpuDtype?: DType,
): Promise<LoadedModel> {
  const key = memoKey(slot, ref, webgpuDtype);
  let p = loaded.get(key);
  if (!p) {
    p = doLoad(slot, ref, onProgress, webgpuDtype);
    loaded.set(key, p);
    p.catch(() => loaded.delete(key));
  }
  return p;
}

export function isLoaded(slot: ModelSlot, ref: ModelRef): boolean {
  return loaded.has(memoKey(slot, ref));
}

async function doLoad(slot: ModelSlot, ref: ModelRef, onProgress?: FileProgress, webgpuDtype?: DType): Promise<LoadedModel> {
  const base = DEFAULT_MODELS[slot];
  const spec: ModelSpec = webgpuDtype
    ? { ...base, wasmOnly: false, dtypes: { ...base.dtypes, webgpuF16: webgpuDtype } }
    : base;
  const key = refKey(ref);
  const progress_callback = onProgress
    ? (p: ProgressInfo) => {
        if (p.status === "progress") onProgress({ key, file: p.file, loaded: p.loaded, total: p.total });
        else if (p.status === "done") onProgress({ key, file: p.file, loaded: -1, total: -1, done: true });
      }
    : undefined;
  const common = { revision: ref.revision, progress_callback };

  const tokenizer = await AutoTokenizer.from_pretrained(ref.repo, common);
  const config = await AutoConfig.from_pretrained(ref.repo, { revision: ref.revision });

  // WASM-only slots run on the CPU backend: "wasm" in browsers, "cpu" in Node scripts.
  const cpuDevice = getRuntimeInfo()?.isNode ? ("cpu" as const) : ("wasm" as const);
  const primary = spec.wasmOnly ? { device: cpuDevice, dtype: spec.dtypes.wasm } : deviceAndDtype(spec.dtypes);
  const attempts: { device: string; dtype: DType }[] = [primary];
  if (primary.device === "webgpu") attempts.push({ device: "wasm", dtype: spec.dtypes.wasm });

  let lastErr: unknown;
  for (const { device, dtype } of attempts) {
    let gpuFailed = false;
    for (const model_file_name of fileCandidates(spec, ref)) {
      try {
        const opts = { ...common, config, device: device as "wasm", dtype: dtype as "q8", model_file_name };
        const model =
          spec.task === "text-classification"
            ? await AutoModelForSequenceClassification.from_pretrained(ref.repo, opts)
            : await AutoModelForCausalLM.from_pretrained(ref.repo, opts);
        return finish(slot, ref, spec, tokenizer, model, device, dtype);
      } catch (e) {
        lastErr = e;
        if (isMissingFileError(e)) continue;
        gpuFailed = device === "webgpu";
        break;
      }
    }
    if (gpuFailed) {
      console.warn("[engine] WebGPU session failed, falling back to WASM:", lastErr);
      disableWebGPU();
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function finish(
  slot: ModelSlot,
  ref: ModelRef,
  spec: ModelSpec,
  tokenizer: PreTrainedTokenizer,
  model: PreTrainedModel,
  device: string,
  dtype: DType,
): LoadedModel {
  const cfg = model.config as unknown as {
    id2label?: Record<string, string>;
    num_labels?: number;
    vocab_size?: number;
    max_position_embeddings?: number;
    n_positions?: number;
  };
  if (spec.task === "text-classification") {
    const numLabels = cfg.num_labels ?? Object.keys(cfg.id2label ?? {}).length ?? 2;
    const tokMax = Number(tokenizer.model_max_length);
    const posMax = cfg.max_position_embeddings ?? Infinity;
    const maxLength = Math.min(
      spec.maxLength,
      Number.isFinite(tokMax) && tokMax > 0 ? tokMax : Infinity,
      posMax >= 128 ? posMax : Infinity,
    );
    return {
      kind: "classifier",
      ref,
      tokenizer,
      model,
      aiIndex: aiLabelIndex(cfg.id2label, numLabels || 2),
      maxLength,
      device,
      dtype,
    };
  }
  const ctx = cfg.n_positions ?? cfg.max_position_embeddings ?? spec.maxLength;
  const window = Math.min(spec.window ?? 512, ctx);
  const overlap = Math.min(spec.overlap ?? 64, Math.floor(window / 2));
  const bosId = (tokenizer as unknown as { bos_token_id?: number | null }).bos_token_id;
  const forward: ForwardFn = async (ids) => {
    const n = ids.length;
    const input_ids = new Tensor("int64", BigInt64Array.from(ids, (x) => BigInt(x)), [1, n]);
    const attention_mask = new Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]);
    const out = (await (model as unknown as (x: unknown) => Promise<{ logits: Tensor }>)({ input_ids, attention_mask }));
    let logits = out.logits;
    if (logits.type !== "float32") logits = logits.to("float32");
    const dims = logits.dims;
    return { data: logits.data as Float32Array, vocab: dims[dims.length - 1]! };
  };
  return {
    kind: "lm",
    ref,
    tokenizer,
    model,
    bos: typeof bosId === "number" && bosId >= 0 ? bosId : null,
    vocab: cfg.vocab_size ?? 0,
    window,
    overlap,
    forward,
    device,
    dtype,
  };
}

/** Disposes loaded sessions (all, or only those for the given refs). */
export async function unloadModels(refs?: ModelRef[]): Promise<number> {
  let n = 0;
  const wanted = refs ? new Set(refs.map(refKey)) : null;
  for (const [key, p] of [...loaded.entries()]) {
    const rk = key.slice(key.indexOf("|") + 1).replace(/#.*$/, "");
    if (wanted && !wanted.has(rk)) continue;
    loaded.delete(key);
    n++;
    try {
      const m = await p;
      await m.model.dispose();
    } catch {
      // failed loads have nothing to dispose
    }
  }
  return n;
}

/** Whether the main ONNX weights for `ref` are already in the model cache. */
export async function isRefCached(slot: ModelSlot, ref: ModelRef): Promise<boolean> {
  const cache = await modelCache();
  if (!cache) return getRuntimeInfo()?.isNode ?? false;
  const prefix = `${cachePrefix(ref)}onnx/`;
  const keys = await cache.keys();
  const spec = DEFAULT_MODELS[slot];
  const dtype = spec.wasmOnly ? spec.dtypes.wasm : deviceAndDtype(spec.dtypes).dtype;
  const suffix = `${DTYPE_SUFFIX[dtype]}.onnx`;
  return keys.some((k) => k.startsWith(prefix) && k.endsWith(suffix));
}
