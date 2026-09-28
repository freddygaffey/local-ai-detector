// Inference host: a dedicated module Worker. Firefox spawns it from the
// background event page (no offscreen API, docs/feasibility.md §1); Chrome
// from the offscreen document (src/engine/offscreenRelay.ts), so inference
// never blocks the popup's main thread. It speaks the same protocol as the Chrome
// offscreen host (src/engine/protocol.ts) over postMessage. The event page
// is unloaded when idle, so this worker and its sessions are disposable; the
// background re-creates it and models come back from the cache in seconds.
//
// No extension APIs exist in a Worker, so the bundled ORT URL is derived
// from the worker's own moz-extension:// location. Firefox extension pages
// can't be cross-origin isolated, so ORT runs single-threaded here.

import { startWorkerHost } from "@/src/engine/host-server";

export default defineUnlistedScript({
  main() {
    startWorkerHost(self as unknown as Parameters<typeof startWorkerHost>[0], {
      ortBaseUrl: new URL("/ort/", self.location.href).href,
      firefox: import.meta.env.FIREFOX,
    });
  },
});
