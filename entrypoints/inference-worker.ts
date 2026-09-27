// Firefox inference host: a dedicated Worker spawned by the background
// event page (there is no offscreen API on Firefox, see docs/feasibility.md
// §1). The event page is unloaded when idle, so treat this worker and its
// loaded model sessions as disposable; the background re-creates it and
// models come back from the Cache API in seconds.
//
// Built by WXT as a plain "unlisted-script" bundle. Instantiate it with:
//   new Worker(browser.runtime.getURL("inference-worker.js"), { type: "module" })
//
// TODO(T1): initialize transformers.js with
// env.backends.onnx.wasm.wasmPaths pointed at the bundled public/ort/ files,
// env.backends.onnx.wasm.numThreads = 1 (no cross-origin isolation on
// Firefox extension pages), load models per src/engine/models.ts, and speak
// the same request/response contract as the Chrome offscreen host so the
// background can treat both the same way.

export default defineUnlistedScript(() => {
  self.onmessage = () => {
    console.log("[Local AI Detector] inference worker loaded (stub, see T1)");
  };
});
