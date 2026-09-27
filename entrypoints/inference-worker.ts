// Firefox inference host: a dedicated module Worker spawned by the
// background event page (Firefox has no offscreen API, see
// docs/feasibility.md §1). It speaks the same protocol as the Chrome
// offscreen host (src/engine/protocol.ts) over postMessage. The event page
// is unloaded when idle, so this worker and its sessions are disposable; the
// background re-creates it and models come back from the cache in seconds.
//
// No extension APIs exist in a Worker, so the bundled ORT URL is derived
// from the worker's own moz-extension:// location. Firefox extension pages
// can't be cross-origin isolated, so ORT runs single-threaded here.

import { startWorkerHost } from "@/src/engine/host-server";

export default defineUnlistedScript({
  // Chrome uses the offscreen document instead.
  include: ["firefox"],
  main() {
    startWorkerHost(self as unknown as Parameters<typeof startWorkerHost>[0], {
      ortBaseUrl: new URL("/ort/", self.location.href).href,
      firefox: true,
    });
  },
});
