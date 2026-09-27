// Chrome offscreen document (inference host). This page is created on
// demand by the background via `chrome.offscreen.createDocument` and is
// never shown to the user. The only extension API available in here is
// `runtime` (see docs/feasibility.md §1).
//
// TODO(T1): initialize transformers.js with env.backends.onnx.wasm.wasmPaths
// pointed at the bundled public/ort/ files (never the CDN), load the
// classifier/perplexity/binoculars models per src/engine/models.ts, keep
// sessions warm across calls, and register handlers (via
// src/shared/messages.ts) that the background forwards `analyze` and
// model-management messages to.

console.log("[Local AI Detector] offscreen document loaded (stub, see T1)");
