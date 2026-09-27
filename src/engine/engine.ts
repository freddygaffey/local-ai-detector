// Inference-host service: implements the HostOps (./protocol.ts) on top of
// the loader and detectors. Runs inside the Chrome offscreen document or the
// Firefox inference Worker (and in Node for scripts). Has no extension-API
// dependencies: everything it needs (mode, model refs, limits) arrives in
// the request, because the offscreen document can only use `runtime` and
// the Worker can use none.

import type { AnalyzeResult, ProgressEvent, TextBlock } from "../shared/messages";
import type { ModelRef, ModelSlot } from "../shared/settings";
import { scanUnicode } from "../detectors/unicode";
import { analyzeBlocks } from "./detect";
import { isRefCached, loadModel, unloadModels, type FileProgress, type LoadedModel } from "./loader";
import { cachePrefix, DEFAULT_MODELS, refKey, sameRef, slotsForMode } from "./models";
import type { CachedRepo, EngineConfig, HostOps } from "./protocol";
import { getRuntimeInfo, initRuntime, modelCache, setWebGPUAllowed, type RuntimeOptions } from "./runtime";
import { BLOCK_SEPARATOR, hashString } from "./text";

type Progress = (p: ProgressEvent) => void;

// ---------------- download/load progress aggregation ----------------

/** Aggregates per-file byte progress across all models being loaded into one event stream. */
export class LoadProgress {
  private files = new Map<string, { loaded: number; total: number }>();
  private lastEmit = 0;
  private emit: Progress | undefined;
  private phase: "download" | "load";
  private label: string;
  private throttleMs: number;

  // (No TS parameter properties: the Node scripts run this file via type stripping.)
  constructor(emit: Progress | undefined, phase: "download" | "load", label: string, throttleMs = 150) {
    this.emit = emit;
    this.phase = phase;
    this.label = label;
    this.throttleMs = throttleMs;
  }

  onFile: FileProgress = ({ key, file, loaded, total, done }) => {
    const k = `${key}/${file}`;
    const prev = this.files.get(k);
    if (done) {
      if (prev) prev.loaded = prev.total;
    } else if (total > 0) {
      this.files.set(k, { loaded, total });
    }
    const now = Date.now();
    if (!done && now - this.lastEmit < this.throttleMs) return;
    this.lastEmit = now;
    this.flush();
  };

  flush(): void {
    let loaded = 0;
    let total = 0;
    for (const f of this.files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    this.emit?.({
      phase: this.phase,
      loaded,
      total,
      message:
        this.phase === "download"
          ? `Downloading ${this.label} (${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB)`
          : `Loading ${this.label}`,
    });
  }
}

// ---------------- model loading with bookkeeping ----------------

/** Last ref loaded per slot, so a changed ref (update / rollback / custom) frees the old session. */
const activeBySlot = new Map<ModelSlot, ModelRef>();

async function ensureModels(
  models: Partial<Record<ModelSlot, ModelRef>>,
  slots: ModelSlot[],
  onProgress?: Progress,
  webgpuDtypes?: EngineConfig["webgpuDtypes"],
): Promise<Partial<Record<ModelSlot, LoadedModel>>> {
  const cached = await Promise.all(slots.map((s) => isRefCached(s, models[s]!)));
  const needsDownload = cached.some((c) => !c);
  const label = slots.map((s) => DEFAULT_MODELS[s].label.split(" (")[0]).join(" + ");
  const agg = new LoadProgress(onProgress, needsDownload ? "download" : "load", label);
  const out: Partial<Record<ModelSlot, LoadedModel>> = {};
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    const ref = models[slot];
    if (!ref) throw new Error(`No model configured for slot "${slot}"`);
    const prev = activeBySlot.get(slot);
    if (prev && !sameRef(prev, ref)) {
      activeBySlot.delete(slot);
      const stillUsed = [...activeBySlot.values()].some((r) => sameRef(r, prev));
      if (!stillUsed) await unloadModels([prev]);
    }
    onProgress?.({ phase: "load", loaded: i, total: slots.length, message: `Loading ${DEFAULT_MODELS[slot].label}` });
    out[slot] = await loadModel(slot, ref, agg.onFile, webgpuDtypes?.[slot]);
    activeBySlot.set(slot, ref);
  }
  onProgress?.({ phase: "load", loaded: slots.length, total: slots.length, message: "Models ready" });
  return out;
}

// ---------------- result cache ----------------

const RESULT_CACHE_MAX = 32;
const resultCache = new Map<string, AnalyzeResult>();

function resultKey(blocks: TextBlock[], config: EngineConfig): string {
  const rt = getRuntimeInfo();
  return hashString(
    JSON.stringify([
      config.url ?? "",
      config.mode,
      config.minWords,
      config.maxTokens,
      config.fusion?.method ?? "",
      JSON.stringify(config.webgpuDtypes ?? {}),
      slotsForMode(config.mode, config.fusion ?? config.ensembleClassifier).map((s) => (config.models[s] ? refKey(config.models[s]!) : "")),
      rt?.device ?? "",
      blocks.map((b) => [b.id, b.text, b.sentences]),
    ]),
  );
}

export function clearResultCache(): void {
  resultCache.clear();
}

// ---------------- ops ----------------

export async function analyze(
  blocks: TextBlock[],
  config: EngineConfig,
  onProgress?: Progress,
): Promise<AnalyzeResult> {
  if (config.allowWebGPU !== undefined && setWebGPUAllowed(config.allowWebGPU)) {
    // Sessions are bound to the device they were created on.
    await unloadModels();
    activeBySlot.clear();
  }
  const key = resultKey(blocks, config);
  const hit = resultCache.get(key);
  if (hit) {
    resultCache.delete(key);
    resultCache.set(key, hit); // LRU bump
    onProgress?.({ phase: "analyze", loaded: 1, total: 1, message: "Cached result" });
    return structuredClone(hit);
  }

  const slots = slotsForMode(config.mode, config.fusion ?? config.ensembleClassifier);
  const models = await ensureModels(config.models, slots, onProgress, config.webgpuDtypes);
  const { result } = await analyzeBlocks(
    blocks,
    {
      mode: config.mode,
      minWords: config.minWords,
      maxTokens: config.maxTokens,
      ensembleClassifier: config.ensembleClassifier,
      fusion: config.fusion,
    },
    models,
    onProgress,
  );
  // One scan over the blocks joined with BLOCK_SEPARATOR ("\n\n"): finding
  // indices are offsets into that joined string, i.e. block k starts at
  // sum(len(block j) + 2 for j < k).
  const unicode = scanUnicode(blocks.map((b) => b.text).join(BLOCK_SEPARATOR));
  const full: AnalyzeResult = { ...result, unicode };

  resultCache.set(key, full);
  while (resultCache.size > RESULT_CACHE_MAX) resultCache.delete(resultCache.keys().next().value!);
  return structuredClone(full);
}

export async function prepare(slot: ModelSlot, ref: ModelRef, onProgress?: Progress): Promise<HostOps["prepare"]["res"]> {
  const cached = await isRefCached(slot, ref);
  const agg = new LoadProgress(onProgress, cached ? "load" : "download", `${ref.repo}@${ref.revision.slice(0, 7)}`);
  const m = await loadModel(slot, ref, agg.onFile);
  // Smoke-test a forward pass so a revision that loads but can't run is rejected too.
  if (m.kind === "classifier") {
    const enc = m.tokenizer("This is a short test sentence.");
    await (m.model as unknown as (x: unknown) => Promise<unknown>)(enc);
  } else {
    const ids = m.tokenizer.encode("This is a test.", { add_special_tokens: false }) as number[];
    const { vocab } = await m.forward(m.bos !== null ? [m.bos, ...ids] : ids);
    if (!(vocab > 0)) throw new Error("Model returned no logits");
  }
  return { device: m.device, dtype: m.dtype };
}

export async function isCached(items: { slot: ModelSlot; ref: ModelRef }[]): Promise<boolean[]> {
  return Promise.all(items.map((i) => isRefCached(i.slot, i.ref)));
}

const HF_FILE_RE = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([^/]+)\//;

/** Groups the model cache by {repo, revision}. */
export async function cacheInfo(): Promise<CachedRepo[]> {
  const cache = await modelCache();
  if (!cache) return [];
  const groups = new Map<string, CachedRepo>();
  for (const url of await cache.keys()) {
    const m = HF_FILE_RE.exec(url);
    if (!m) continue;
    const repo = m[1]!;
    const revision = decodeURIComponent(m[2]!);
    const k = `${repo}@${revision}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { repo, revision, bytes: 0, files: 0 }));
    g.bytes += await cache.size(url);
    g.files++;
  }
  return [...groups.values()];
}

export async function deleteCache(refs: ModelRef[]): Promise<{ freedBytes: number }> {
  await unloadModels(refs);
  for (const [slot, r] of [...activeBySlot.entries()]) {
    if (refs.some((x) => sameRef(x, r))) activeBySlot.delete(slot);
  }
  clearResultCache();
  const cache = await modelCache();
  if (!cache) return { freedBytes: 0 };
  const prefixes = refs.map((r) => cachePrefix(r));
  let freed = 0;
  for (const url of await cache.keys()) {
    if (!prefixes.some((p) => url.startsWith(p))) continue;
    freed += await cache.size(url);
    await cache.delete(url);
  }
  return { freedBytes: freed };
}

/** Ops that touch model sessions run one at a time, in arrival order. */
const SERIAL_OPS = new Set<keyof HostOps>(["analyze", "prepare", "deleteCache", "unload"]);
let serial: Promise<unknown> = Promise.resolve();

/** Dispatches one host op. `init` configures the runtime on first use. */
export function handleHostOp<O extends keyof HostOps>(
  op: O,
  payload: HostOps[O]["req"],
  init: RuntimeOptions,
  onProgress?: Progress,
): Promise<HostOps[O]["res"]> {
  if (!SERIAL_OPS.has(op)) return runHostOp(op, payload, init, onProgress);
  const run = serial.then(
    () => runHostOp(op, payload, init, onProgress),
    () => runHostOp(op, payload, init, onProgress),
  );
  serial = run.catch(() => undefined);
  return run;
}

async function runHostOp<O extends keyof HostOps>(
  op: O,
  payload: HostOps[O]["req"],
  init: RuntimeOptions,
  onProgress?: Progress,
): Promise<HostOps[O]["res"]> {
  await initRuntime(init);
  type R = HostOps[O]["res"];
  switch (op) {
    case "ping":
      return { ok: true, ts: Date.now() } as R;
    case "analyze": {
      const p = payload as HostOps["analyze"]["req"];
      return (await analyze(p.blocks, p.config, onProgress)) as R;
    }
    case "prepare": {
      const p = payload as HostOps["prepare"]["req"];
      return (await prepare(p.slot, p.ref, onProgress)) as R;
    }
    case "isCached":
      return (await isCached((payload as HostOps["isCached"]["req"]).items)) as R;
    case "cacheInfo":
      return (await cacheInfo()) as R;
    case "deleteCache":
      return (await deleteCache((payload as HostOps["deleteCache"]["req"]).refs)) as R;
    case "unload": {
      const refs = (payload as HostOps["unload"]["req"])?.refs;
      const unloaded = await unloadModels(refs);
      if (!refs) activeBySlot.clear();
      return { unloaded } as R;
    }
    case "runtime": {
      const i = getRuntimeInfo();
      return (i
        ? {
            device: i.device,
            shaderF16: i.shaderF16,
            threads: i.threads,
            crossOriginIsolated: i.crossOriginIsolated,
            cache: i.cache,
            persisted: i.persisted,
          }
        : null) as R;
    }
    default:
      throw new Error(`Unknown host op "${String(op)}"`);
  }
}
