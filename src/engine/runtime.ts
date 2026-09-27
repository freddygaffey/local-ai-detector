// transformers.js / ONNX Runtime environment setup for the inference host
// (Chrome offscreen document, Firefox dedicated Worker, or Node for scripts).
//
// Store-review critical: ORT's WASM glue + binary are always loaded from the
// extension's own bundled `ort/` directory, never from jsDelivr (transformers.js
// defaults to the CDN when wasmPaths is unset; docs/feasibility.md §1).

import { env } from "@huggingface/transformers";
import type { DType } from "./models";
import { IdbCache } from "./idb-cache";

export type DeviceKind = "webgpu" | "wasm" | "cpu";

export interface RuntimeInfo {
  device: DeviceKind;
  /** WebGPU adapter supports the shader-f16 feature (q4f16/fp16 weights). */
  shaderF16: boolean;
  threads: number;
  crossOriginIsolated: boolean;
  cache: "cache-api" | "indexeddb" | "filesystem" | "none";
  /** Result of navigator.storage.persist(), when callable here. */
  persisted: boolean | null;
  isNode: boolean;
}

export interface RuntimeOptions {
  /** Absolute URL of the bundled ORT directory, e.g. chrome-extension://<id>/ort/ */
  ortBaseUrl?: string;
  firefox?: boolean;
  /** Set false to force WASM even when WebGPU is available. */
  allowWebGPU?: boolean;
  /** Node only: filesystem cache directory for downloaded models. */
  cacheDir?: string;
}

/** Name of the bundled ORT files (copied by scripts/copy-vendor-assets.mjs). */
export const ORT_FILES = {
  mjs: "ort-wasm-simd-threaded.asyncify.mjs",
  wasm: "ort-wasm-simd-threaded.asyncify.wasm",
};

export const CACHE_NAME = "transformers-cache";

let info: RuntimeInfo | null = null;
let initPromise: Promise<RuntimeInfo> | null = null;
let idb: IdbCache | null = null;

export function isNodeRuntime(): boolean {
  const p = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return !!p?.versions?.node && typeof (globalThis as { window?: unknown }).window === "undefined" &&
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope === "undefined";
}

/** Default ORT base URL: `<extension origin>/ort/`, derived from this context's location. */
export function defaultOrtBaseUrl(): string | undefined {
  const loc = (globalThis as { location?: Location }).location;
  if (!loc || !/^(chrome|moz)-extension:$/.test(loc.protocol)) return undefined;
  return `${loc.origin}/ort/`;
}

async function cacheApiUsable(): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  try {
    const c = await caches.open(CACHE_NAME);
    // A probe round-trip catches contexts where the API exists but throws on use.
    const probe = "https://huggingface.co/__local-ai-detector-cache-probe__";
    await c.put(probe, new Response("ok"));
    const hit = await c.match(probe);
    await c.delete(probe);
    return !!hit;
  } catch {
    return false;
  }
}

async function detectWebGPU(): Promise<{ ok: boolean; f16: boolean }> {
  const gpu = (globalThis.navigator as Navigator & { gpu?: { requestAdapter(o?: unknown): Promise<unknown> } })?.gpu;
  if (!gpu) return { ok: false, f16: false };
  try {
    const adapter = (await gpu.requestAdapter({ powerPreference: "high-performance" })) as
      | { features?: { has(f: string): boolean } }
      | null;
    if (!adapter) return { ok: false, f16: false };
    return { ok: true, f16: !!adapter.features?.has("shader-f16") };
  } catch {
    return { ok: false, f16: false };
  }
}

/** Configures transformers.js once per context. Safe to call repeatedly. */
export function initRuntime(opts: RuntimeOptions = {}): Promise<RuntimeInfo> {
  if (!initPromise) {
    initPromise = doInit(opts).then((i) => (info = i));
    initPromise.catch(() => {
      initPromise = null;
    });
  }
  return initPromise;
}

async function doInit(opts: RuntimeOptions): Promise<RuntimeInfo> {
  env.allowRemoteModels = true;

  if (isNodeRuntime()) {
    // Node (calibration / smoke scripts): onnxruntime-node on CPU, FS cache
    // at opts.cacheDir (or transformers.js' default).
    if (opts.cacheDir) env.cacheDir = opts.cacheDir;
    return {
      device: "cpu",
      shaderF16: false,
      threads: 0,
      crossOriginIsolated: false,
      cache: "filesystem",
      persisted: null,
      isNode: true,
    };
  }

  env.allowLocalModels = false; // don't probe <extension>/models/
  env.useFS = false;
  env.useFSCache = false;
  // The WASM pre-cache turns the ORT .mjs into a blob: URL module, which the
  // extension CSP (script-src 'self') forbids. The .wasm is bundled anyway.
  env.useWasmCache = false;

  const ortBase = opts.ortBaseUrl ?? defaultOrtBaseUrl();
  const onnx = env.backends.onnx as { wasm?: Record<string, unknown> };
  if (!onnx.wasm) throw new Error("onnxruntime-web WASM backend unavailable");
  if (!ortBase) {
    throw new Error("Refusing to run without a bundled ORT path (would fall back to the jsDelivr CDN)");
  }
  onnx.wasm.wasmPaths = { mjs: ortBase + ORT_FILES.mjs, wasm: ortBase + ORT_FILES.wasm };
  onnx.wasm.proxy = false;

  const coi = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const hw = globalThis.navigator?.hardwareConcurrency ?? 1;
  // Firefox extension pages can't be cross-origin isolated (bug 1673477), so
  // no SharedArrayBuffer and no WASM threads there.
  const threads = !opts.firefox && coi ? Math.max(1, Math.min(4, hw)) : 1;
  onnx.wasm.numThreads = threads;

  // Model cache: Cache API, else IndexedDB custom cache.
  let cache: RuntimeInfo["cache"] = "none";
  if (await cacheApiUsable()) {
    env.useBrowserCache = true;
    env.useCustomCache = false;
    env.cacheKey = CACHE_NAME;
    cache = "cache-api";
  } else if (IdbCache.isAvailable()) {
    idb = new IdbCache();
    env.useBrowserCache = false;
    env.useCustomCache = true;
    env.customCache = idb as unknown as typeof env.customCache;
    cache = "indexeddb";
  } else {
    env.useBrowserCache = false;
  }

  // Ask the browser not to evict ~100-500 MB of weights. persist() only
  // exists on Window, so this is a no-op inside the Firefox worker (the
  // event page / options page can also call it).
  let persisted: boolean | null = null;
  try {
    const storage = globalThis.navigator?.storage as StorageManager | undefined;
    if (storage && typeof storage.persist === "function") {
      persisted = (await storage.persisted?.()) || (await storage.persist());
    }
  } catch {
    persisted = null;
  }

  const gpu = opts.allowWebGPU === false ? { ok: false, f16: false } : await detectWebGPU();
  // WebGPU only with shader-f16: without it the choice is fp32 (2-4x the
  // download) or q8 (int8 MatMulInteger isn't a WebGPU kernel and falls back
  // to CPU partitions), so WASM q8 is the better deal.
  gpuUsable = gpu.ok && gpu.f16;
  const device: DeviceKind = gpuUsable ? "webgpu" : "wasm";

  return {
    device,
    shaderF16: gpu.f16,
    threads,
    crossOriginIsolated: coi,
    cache,
    persisted,
    isNode: false,
  };
}

export function getRuntimeInfo(): RuntimeInfo | null {
  return info;
}

let gpuUsable = false; // WebGPU with shader-f16 detected at init
let gpuFailed = false; // a WebGPU session failed since

/** Downgrades to WASM after a WebGPU failure (session creation / run). */
export function disableWebGPU(): void {
  gpuFailed = true;
  if (info && info.device === "webgpu") info = { ...info, device: "wasm" };
}

/**
 * Applies the user's "use the GPU" setting. Returns true if the device
 * changed (the caller must then unload loaded sessions, which are bound to
 * the old device).
 */
export function setWebGPUAllowed(allowed: boolean): boolean {
  if (!info || info.isNode) return false;
  const want: DeviceKind = allowed && gpuUsable && !gpuFailed ? "webgpu" : "wasm";
  if (info.device === want) return false;
  info = { ...info, device: want };
  return true;
}

/** transformers.js {device, dtype} for a slot given the runtime. */
export function deviceAndDtype(dtypes: { wasm: DType; webgpuF16: DType }): { device: DeviceKind; dtype: DType } {
  const i = info;
  if (!i) return { device: "wasm", dtype: dtypes.wasm };
  if (i.device === "webgpu") return { device: "webgpu", dtype: dtypes.webgpuF16 };
  return { device: i.device, dtype: dtypes.wasm };
}

/** Minimal view of whichever model cache is active, for cache admin. */
export interface CacheView {
  keys(): Promise<string[]>;
  size(url: string): Promise<number>;
  delete(url: string): Promise<boolean>;
  has(url: string): Promise<boolean>;
}

export async function modelCache(): Promise<CacheView | null> {
  const i = info;
  if (!i) return null;
  if (i.cache === "cache-api") {
    const c = await caches.open(CACHE_NAME);
    return {
      keys: async () => (await c.keys()).map((r) => r.url),
      size: async (url) => {
        const r = await c.match(url);
        if (!r) return 0;
        const len = Number(r.headers.get("content-length"));
        if (Number.isFinite(len) && len > 0) return len;
        return (await r.blob()).size;
      },
      delete: (url) => c.delete(url),
      has: async (url) => !!(await c.match(url)),
    };
  }
  if (i.cache === "indexeddb" && idb) {
    const db = idb;
    return {
      keys: () => db.keys(),
      size: (url) => db.size(url),
      delete: (url) => db.delete(url),
      has: async (url) => (await db.keys()).includes(url),
    };
  }
  return null;
}
