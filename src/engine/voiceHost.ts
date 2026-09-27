// Voice-check inference host (T11): runs in the Chrome offscreen document
// (registerVoiceOffscreenHost) and in a dedicated Firefox worker
// (entrypoints/voice-worker.ts -> startVoiceWorkerHost). onnxruntime-web is
// used directly (these are not transformers.js models), from the same
// bundled ort/ files as the text engine (never a CDN).
//
// Download: streamed from this project's GitHub Release (./voiceModels.ts)
// with progress, size- and sha256-verified as it arrives (refuses to load on
// a mismatch), then stored in the same Cache API cache as the text models
// (IndexedDB fallback), keyed by its URL. GitHub sends no CORS headers, so
// the fetch relies on the github.com / release-assets host permissions.
// Device: fp32 on WebGPU where available, WASM otherwise (or if the WebGPU
// session fails). Sessions are dropped after VOICE_IDLE_MS unused: the
// weights are ~1.3 GB.

import * as ort from "onnxruntime-web/webgpu";
import { VOICE_MODELS, voiceModelUrl, type VoiceModelSpec } from "./voiceModels";
import { Sha256 } from "./sha256";
import { IdbCache } from "./idb-cache";
import { CLIP_SAMPLES } from "../voice/schedule";
import type { VoiceModelId } from "../voice/aggregate";
import { decodePcm, isVoiceHostRequest, type VoiceHostRequest, type VoiceProgress, type VoiceResponse } from "../voice/protocol";

const VOICE_IDLE_MS = 5 * 60_000;
// Same values as ./runtime.ts (CACHE_NAME, ORT_FILES), copied rather than
// imported so the Firefox voice worker doesn't bundle transformers.js
// (voiceHost.test.ts checks they stay equal).
export const VOICE_CACHE_NAME = "transformers-cache";
export const VOICE_ORT_FILES = {
  mjs: "ort-wasm-simd-threaded.asyncify.mjs",
  wasm: "ort-wasm-simd-threaded.asyncify.wasm",
};

interface Loaded {
  session: ort.InferenceSession;
  device: "webgpu" | "wasm";
}

interface CacheLike {
  match(url: string): Promise<Response | undefined>;
  put(url: string, r: Response): Promise<void>;
}

let cachePromise: Promise<CacheLike | null> | null = null;
function openCache(): Promise<CacheLike | null> {
  cachePromise ??= (async () => {
    try {
      if (typeof caches !== "undefined") {
        const c = await caches.open(VOICE_CACHE_NAME);
        return { match: (u) => c.match(u), put: (u, r) => c.put(u, r) };
      }
    } catch {
      // fall through to IndexedDB
    }
    return IdbCache.isAvailable() ? new IdbCache() : null;
  })();
  return cachePromise;
}

export class IntegrityError extends Error {}

/** Streams the model in, verifying size + sha256. Exported for tests. */
export async function downloadVerified(
  spec: VoiceModelSpec,
  fetchImpl: typeof fetch,
  onProgress: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  const res = await fetchImpl(voiceModelUrl(spec), { credentials: "omit" });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const buf = new Uint8Array(spec.bytes);
  const hash = new Sha256();
  const reader = res.body.getReader();
  let loaded = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > spec.bytes) throw new IntegrityError("Model file is larger than expected");
    buf.set(value, loaded);
    hash.update(value);
    loaded += value.length;
    if (loaded - lastReport > 8 * 1024 * 1024) {
      lastReport = loaded;
      onProgress(loaded, spec.bytes);
    }
  }
  onProgress(loaded, spec.bytes);
  if (loaded !== spec.bytes) throw new IntegrityError("Model file is truncated");
  if (hash.hex() !== spec.sha256) throw new IntegrityError("Model file failed its sha256 check");
  return buf;
}

// One download per model at a time: the popup's "Download & enable" and a
// first clip from a tab can overlap.
const inflight = new Map<string, Promise<Uint8Array>>();
function modelBytes(spec: VoiceModelSpec, onProgress: (l: number, t: number) => void): Promise<Uint8Array> {
  let p = inflight.get(spec.id);
  if (!p) {
    p = fetchModelBytes(spec, onProgress).finally(() => inflight.delete(spec.id));
    inflight.set(spec.id, p);
  }
  return p;
}

async function fetchModelBytes(spec: VoiceModelSpec, onProgress: (l: number, t: number) => void): Promise<Uint8Array> {
  const cache = await openCache();
  const url = voiceModelUrl(spec);
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) {
    const b = new Uint8Array(await hit.arrayBuffer());
    if (b.length === spec.bytes) return b; // verified when it was stored
  }
  const bytes = await downloadVerified(spec, fetch.bind(globalThis), onProgress);
  await cache
    ?.put(url, new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) } }))
    .catch((e: unknown) => console.warn("[voice] could not cache model", e));
  return bytes;
}

export async function isVoiceModelCached(id: VoiceModelId): Promise<boolean> {
  const cache = await openCache();
  return !!(await cache?.match(voiceModelUrl(VOICE_MODELS[id])).catch(() => undefined));
}

let ortConfigured = false;
function configureOrt(ortBaseUrl: string, firefox: boolean): void {
  if (ortConfigured) return;
  ortConfigured = true;
  ort.env.wasm.wasmPaths = { mjs: ortBaseUrl + VOICE_ORT_FILES.mjs, wasm: ortBaseUrl + VOICE_ORT_FILES.wasm };
  ort.env.wasm.proxy = false;
  const coi = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const hw = globalThis.navigator?.hardwareConcurrency ?? 1;
  ort.env.wasm.numThreads = !firefox && coi ? Math.max(1, Math.min(4, hw)) : 1;
}

async function createSession(bytes: Uint8Array, allowWebGPU: boolean): Promise<Loaded> {
  const hasGpu = !!(globalThis.navigator as Navigator & { gpu?: unknown })?.gpu;
  if (allowWebGPU && hasGpu) {
    try {
      return { session: await ort.InferenceSession.create(bytes, { executionProviders: ["webgpu"] }), device: "webgpu" };
    } catch (e) {
      console.warn("[voice] WebGPU session failed, using WASM", e);
    }
  }
  return { session: await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] }), device: "wasm" };
}

const sessions = new Map<VoiceModelId, Promise<Loaded>>();
const idleTimers = new Map<VoiceModelId, ReturnType<typeof setTimeout>>();
let queue: Promise<unknown> = Promise.resolve();

function touch(id: VoiceModelId): void {
  clearTimeout(idleTimers.get(id));
  idleTimers.set(
    id,
    setTimeout(() => {
      const s = sessions.get(id);
      sessions.delete(id);
      void s?.then((l) => l.session.release()).catch(() => {});
    }, VOICE_IDLE_MS),
  );
}

function load(id: VoiceModelId, allowWebGPU: boolean, onProgress: (l: number, t: number) => void): Promise<Loaded> {
  let p = sessions.get(id);
  if (!p) {
    p = modelBytes(VOICE_MODELS[id], onProgress).then((b) => createSession(b, allowWebGPU));
    sessions.set(id, p);
    p.catch(() => sessions.delete(id));
  }
  return p;
}

/** Applies preemphasis if the model wants it, pads/crops to the model's input length. */
export function prepareInput(x: Float32Array, preemphasis: boolean): Float32Array {
  const out = new Float32Array(CLIP_SAMPLES);
  const n = Math.min(x.length, CLIP_SAMPLES);
  for (let i = 0; i < n; i++) out[i] = preemphasis && i > 0 ? x[i]! - 0.97 * x[i - 1]! : x[i]!;
  return out;
}

export async function handleVoiceHost(req: VoiceHostRequest, onProgress: (p: VoiceProgress) => void): Promise<VoiceResponse> {
  try {
    if (req.op === "status") return { ok: true, cached: await isVoiceModelCached(req.model) };
    const spec = VOICE_MODELS[req.model];
    if (req.op === "download") {
      if (!spec) return { ok: false, error: "bad request", code: "failed" };
      if (!(await isVoiceModelCached(req.model))) {
        await modelBytes(spec, (l, t) => onProgress({ kind: "lad-voice-progress", id: req.id, loaded: l, total: t }));
      }
      return { ok: true, cached: true };
    }
    if (!spec || !req.pcmB64) return { ok: false, error: "bad request", code: "failed" };
    const run = queue.then(async () => {
      const loaded = await load(req.model, req.allowWebGPU, (l, t) => onProgress({ kind: "lad-voice-progress", id: req.id, loaded: l, total: t }));
      touch(req.model);
      const input = prepareInput(decodePcm(req.pcmB64!), spec.preemphasis);
      const t0 = performance.now();
      const out = await loaded.session.run({ wav: new ort.Tensor("float32", input, [1, CLIP_SAMPLES]) });
      const logits = (out.logits ?? Object.values(out)[0])!.data as Float32Array;
      return { ok: true as const, margin: logits[0]! - logits[1]!, ms: Math.round(performance.now() - t0), device: loaded.device };
    });
    queue = run.catch(() => undefined);
    return await run;
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      code: e instanceof IntegrityError ? "integrity" : "failed",
    };
  }
}

interface MinimalRuntime {
  id?: string;
  onMessage: { addListener(cb: (m: unknown, s: { tab?: unknown; id?: string }, r: (x: unknown) => void) => boolean | undefined): void };
  sendMessage(m: unknown): Promise<unknown> | void;
}

/** Chrome offscreen document: answer the background's voice requests. */
export function registerVoiceOffscreenHost(runtime: MinimalRuntime, ortBaseUrl: string): void {
  configureOrt(ortBaseUrl, false);
  runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isVoiceHostRequest(msg) || sender.tab) return undefined;
    void handleVoiceHost(msg, (p) => {
      try {
        const r = runtime.sendMessage(p);
        if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch(() => {});
      } catch {
        // progress is best-effort
      }
    }).then(sendResponse);
    return true;
  });
}

/** Firefox dedicated worker. Replies are {id, res}. */
export function startVoiceWorkerHost(scope: { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown): void }, ortBaseUrl: string): void {
  configureOrt(ortBaseUrl, true);
  scope.onmessage = (e) => {
    const msg = e.data;
    if (!isVoiceHostRequest(msg)) return;
    void handleVoiceHost(msg, (p) => scope.postMessage(p)).then((res) => scope.postMessage({ id: msg.id, res }));
  };
}
