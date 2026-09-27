// Owned by T1: inference engine. Model registry (src/engine/models.ts),
// classifier / perplexity / binoculars / ensemble scoring, chunking,
// sentence-offset mapping, progress reporting, Cache API storage with an
// IndexedDB fallback, WebGPU/WASM device selection, and the
// update/rollback/custom-model/validation backend for
// checkModelUpdates/updateModel/rollbackModel/setCustomModel/deleteCachedModel
// (see src/shared/messages.ts). Consumed by entrypoints/offscreen (Chrome)
// and entrypoints/inference-worker.ts (Firefox).
//
// Intentionally empty in T0; this file exists so the directory is tracked
// and other tasks have a stable import path (`@/src/engine`) to fill in.

export {};
