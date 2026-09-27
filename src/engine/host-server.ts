// Inference-host entry points: glue between the transport (Chrome offscreen
// runtime messaging, or a Firefox Worker's postMessage) and handleHostOp.

import type { ProgressEvent } from "../shared/messages";
import { handleHostOp } from "./engine";
import {
  isHostRequest,
  type HostProgressEnvelope,
  type HostRequestEnvelope,
  type HostResponseEnvelope,
} from "./protocol";
import type { RuntimeOptions } from "./runtime";

/** Runs one request envelope and returns its response envelope (never throws). */
export async function serveHostRequest(
  req: HostRequestEnvelope,
  init: RuntimeOptions,
  onProgress: (p: ProgressEvent) => void,
): Promise<HostResponseEnvelope> {
  try {
    const result = await handleHostOp(req.op, req.payload as never, init, onProgress);
    return { kind: "lad-host-response", id: req.id, ok: true, result };
  } catch (err) {
    console.error(`[engine] host op "${req.op}" failed`, err);
    return {
      kind: "lad-host-response",
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface MinimalRuntime {
  id?: string;
  onMessage: {
    addListener(
      cb: (msg: unknown, sender: { id?: string; tab?: unknown }, sendResponse: (r: unknown) => void) => boolean | undefined,
    ): void;
  };
  sendMessage(msg: unknown): Promise<unknown> | void;
}

/**
 * Chrome offscreen document: listen for host requests from the background
 * service worker on runtime messaging, answer via sendResponse, stream
 * progress back as separate runtime messages.
 */
export function startOffscreenHost(runtime: MinimalRuntime, init: RuntimeOptions = {}): void {
  runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isHostRequest(msg)) return undefined;
    // Only the extension's own background (not content scripts in tabs) drives the host.
    if (sender.tab || (sender.id && runtime.id && sender.id !== runtime.id)) return undefined;
    const onProgress = (progress: ProgressEvent) => {
      const env: HostProgressEnvelope = { kind: "lad-host-progress", id: msg.id, progress };
      try {
        const p = runtime.sendMessage(env);
        if (p && typeof (p as Promise<unknown>).catch === "function") (p as Promise<unknown>).catch(() => {});
      } catch {
        // background asleep/gone: progress is best-effort
      }
    };
    void serveHostRequest(msg, init, onProgress).then(sendResponse);
    return true; // async sendResponse
  });
}

/** Firefox dedicated Worker: same protocol over postMessage. */
export function startWorkerHost(scope: {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: unknown): void;
}, init: RuntimeOptions = {}): void {
  scope.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (!isHostRequest(msg)) return;
    const onProgress = (progress: ProgressEvent) => {
      const env: HostProgressEnvelope = { kind: "lad-host-progress", id: msg.id, progress };
      scope.postMessage(env);
    };
    void serveHostRequest(msg, init, onProgress).then((res) => scope.postMessage(res));
  };
}
