// Background-side client for the inference host. Chrome: ensures the single
// offscreen document exists (re-creating it if it was closed or crashed) and
// talks to it over runtime messaging. Firefox: spawns the dedicated
// inference Worker from the event page (re-spawning after an error or an
// event-page reload) and talks to it over postMessage.

import { browser } from "wxt/browser";
import type { ProgressEvent } from "../shared/messages";
import {
  isHostProgress,
  isHostResponse,
  type HostOp,
  type HostOps,
  type HostRequestEnvelope,
  type HostResponseEnvelope,
} from "./protocol";

export interface HostClient {
  kind: "offscreen" | "worker";
  call<O extends HostOp>(op: O, payload: HostOps[O]["req"], onProgress?: (p: ProgressEvent) => void): Promise<HostOps[O]["res"]>;
  /** Tear the host down (next call re-creates it). */
  reset(): Promise<void>;
}

let counter = 0;
const newId = () => `h${Date.now().toString(36)}-${++counter}`;

function unwrap<O extends HostOp>(res: HostResponseEnvelope<O> | undefined, op: O): HostOps[O]["res"] {
  if (!res || !isHostResponse(res)) throw new Error(`Inference host gave no response to "${op}"`);
  if (!res.ok) throw new Error(res.error ?? `Inference host op "${op}" failed`);
  return res.result as HostOps[O]["res"];
}

// ---------------- Chrome: offscreen document ----------------

const OFFSCREEN_PATH = "offscreen.html";

interface OffscreenApi {
  createDocument(p: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
  hasDocument?: () => Promise<boolean>;
}

function offscreenApi(): OffscreenApi | undefined {
  return (browser as unknown as { offscreen?: OffscreenApi }).offscreen;
}

function createOffscreenClient(): HostClient {
  const api = offscreenApi()!;
  const url = browser.runtime.getURL(`/${OFFSCREEN_PATH}` as "/");
  const progressHandlers = new Map<string, (p: ProgressEvent) => void>();
  let creating: Promise<void> | null = null;

  browser.runtime.onMessage.addListener((msg: unknown) => {
    if (isHostProgress(msg)) progressHandlers.get(msg.id)?.(msg.progress);
    return undefined;
  });

  async function hasDocument(): Promise<boolean> {
    const rt = browser.runtime as unknown as {
      getContexts?: (f: { contextTypes: string[]; documentUrls?: string[] }) => Promise<unknown[]>;
    };
    if (rt.getContexts) {
      const ctx = await rt.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
      return ctx.length > 0;
    }
    if (api.hasDocument) return api.hasDocument();
    return false;
  }

  async function ensure(): Promise<void> {
    if (await hasDocument()) return;
    if (!creating) {
      creating = api
        .createDocument({
          url,
          reasons: ["WORKERS"],
          justification:
            "Runs the local AI-text detection models (ONNX Runtime WASM/WebGPU workers) outside the service worker, so they stay loaded between analyses.",
        })
        .catch((e: unknown) => {
          // A concurrent caller may have created it first.
          if (!/single offscreen|only a single|already/i.test(String(e))) throw e;
        })
        .finally(() => {
          creating = null;
        });
    }
    await creating;
  }

  async function send<O extends HostOp>(op: O, payload: HostOps[O]["req"], id: string) {
    const req: HostRequestEnvelope<O> = { kind: "lad-host-request", id, op, payload };
    return (await browser.runtime.sendMessage(req)) as HostResponseEnvelope<O> | undefined;
  }

  const client: HostClient = {
    kind: "offscreen",
    async call(op, payload, onProgress) {
      const id = newId();
      if (onProgress) progressHandlers.set(id, onProgress);
      try {
        for (let attempt = 0; ; attempt++) {
          await ensure();
          try {
            const res = await send(op, payload, id);
            if (res === undefined && attempt < 20) {
              // Document exists but its listener isn't registered yet.
              await new Promise((r) => setTimeout(r, 100));
              continue;
            }
            return unwrap(res, op);
          } catch (e) {
            const msg = String(e);
            if (attempt < 20 && /Receiving end does not exist|Could not establish connection|message port closed/i.test(msg)) {
              await new Promise((r) => setTimeout(r, 100));
              continue;
            }
            throw e;
          }
        }
      } finally {
        progressHandlers.delete(id);
      }
    },
    async reset() {
      if (await hasDocument()) await api.closeDocument().catch(() => {});
    },
  };
  return client;
}

// ---------------- Firefox: dedicated Worker ----------------

const WORKER_PATH = "inference-worker.js";

function createWorkerClient(): HostClient {
  let worker: Worker | null = null;
  const pending = new Map<
    string,
    { resolve: (r: HostResponseEnvelope) => void; reject: (e: Error) => void; onProgress?: (p: ProgressEvent) => void }
  >();
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  function failAll(err: Error) {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    stopKeepAlive();
  }

  // Firefox unloads an idle event page (and with it this worker) after ~30 s
  // without extension events. Touch a cheap extension API while work is in
  // flight so a long download/analysis isn't cut off. T5: verify in Firefox.
  function startKeepAlive() {
    if (keepAlive) return;
    keepAlive = setInterval(() => {
      void browser.runtime.getPlatformInfo().catch(() => {});
    }, 15_000);
  }
  function stopKeepAlive() {
    if (keepAlive && pending.size === 0) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
  }

  function ensure(): Worker {
    if (worker) return worker;
    const w = new Worker(browser.runtime.getURL(`/${WORKER_PATH}` as "/"), { type: "module" });
    w.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (isHostProgress(msg)) {
        pending.get(msg.id)?.onProgress?.(msg.progress);
        void browser.runtime.getPlatformInfo().catch(() => {});
      } else if (isHostResponse(msg)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        stopKeepAlive();
        p?.resolve(msg);
      }
    };
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      console.error("[engine] inference worker error", e.message);
      worker = null;
      w.terminate();
      failAll(new Error(`Inference worker crashed: ${e.message || "unknown error"}`));
    };
    worker = w;
    return w;
  }

  return {
    kind: "worker",
    call(op, payload, onProgress) {
      const id = newId();
      return new Promise<HostResponseEnvelope>((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress });
        startKeepAlive();
        const req: HostRequestEnvelope = { kind: "lad-host-request", id, op, payload };
        try {
          ensure().postMessage(req);
        } catch (e) {
          pending.delete(id);
          stopKeepAlive();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }).then((res) => unwrap(res as HostResponseEnvelope<typeof op>, op));
    },
    async reset() {
      worker?.terminate();
      worker = null;
      failAll(new Error("Inference host was reset"));
    },
  };
}

let client: HostClient | null = null;

/** The inference host client for this browser (lazily created). */
export function getHostClient(): HostClient {
  if (client) return client;
  if (offscreenApi()?.createDocument) client = createOffscreenClient();
  else if (typeof Worker !== "undefined") client = createWorkerClient();
  else throw new Error("No way to run the inference host here (no offscreen API and no Worker)");
  return client;
}
