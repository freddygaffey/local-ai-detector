// Chrome offscreen document (inference host). Created on demand by the
// background service worker via `chrome.offscreen.createDocument` (reason
// WORKERS) and never shown. The only extension API available in here is
// `runtime` (docs/feasibility.md §1), so everything the engine needs arrives
// in each request from the background (see src/engine/protocol.ts).
//
// transformers.js is configured in src/engine/runtime.ts: ORT WASM from the
// bundled ort/ directory (never the CDN), multi-threaded when the page is
// cross-origin isolated, WebGPU when an adapter with shader-f16 exists.
//
// Other features may register their own offscreen handlers below (one
// import + one call each).

import { browser } from "wxt/browser";
import { startOffscreenHost } from "@/src/engine/host-server";

startOffscreenHost(browser.runtime as unknown as Parameters<typeof startOffscreenHost>[0], {
  ortBaseUrl: browser.runtime.getURL("/ort/" as "/"),
  firefox: false,
});
