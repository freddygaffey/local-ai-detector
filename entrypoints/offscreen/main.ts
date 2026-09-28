// Chrome offscreen document (inference host). Created on demand by the
// background service worker via `chrome.offscreen.createDocument` (reason
// WORKERS) and never shown. The only extension API available in here is
// `runtime` (docs/feasibility.md §1), so everything the engine needs arrives
// in each request from the background (see src/engine/protocol.ts).
//
// transformers.js runs in the workers (entrypoints/inference-worker.ts,
// voice-worker.ts), configured in src/engine/runtime.ts.
//
// Other features may register their own offscreen handlers below (one
// import + one call each).

import { browser } from "wxt/browser";
import { startOffscreenRelay } from "@/src/engine/offscreenRelay";
import { isHostRequest, isHostResponse } from "@/src/engine/protocol";
import { isVoiceHostRequest } from "@/src/voice/protocol";
import { registerProvenanceHost } from "@/src/provenance/host";

type RelayRuntime = Parameters<typeof startOffscreenRelay>[0];
const runtime = browser.runtime as unknown as RelayRuntime;

// Text inference and the voice check run in dedicated Workers (the same hosts
// Firefox uses): this page shares the popup's main thread (src/engine/offscreenRelay.ts).
startOffscreenRelay(runtime, {
  workerUrl: browser.runtime.getURL("/inference-worker.js" as "/"),
  isRequest: isHostRequest,
  asReply: (m) => (isHostResponse(m) ? { id: m.id, reply: m } : null),
  crashReply: (id, error) => ({ kind: "lad-host-response", id, ok: false, error }),
});

startOffscreenRelay(runtime, {
  workerUrl: browser.runtime.getURL("/voice-worker.js" as "/"),
  isRequest: isVoiceHostRequest,
  asReply: (m) => {
    const r = m as { id?: string; res?: unknown };
    return typeof r?.id === "string" && r.res !== undefined ? { id: r.id, reply: r.res } : null;
  },
  crashReply: (_id, error) => ({ ok: false, error, code: "failed" }),
});

registerProvenanceHost();
