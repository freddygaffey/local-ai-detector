// Private wire protocol between the background router and the inference
// host (Chrome offscreen document via runtime messaging, Firefox dedicated
// Worker via postMessage). Distinct `kind` strings keep it from colliding
// with the shared request/response envelopes in src/shared/messages.ts.

import type { AnalyzeResult, EngineInfo, ProgressEvent, TextBlock } from "../shared/messages";
import type { DType } from "./models";
import type { EnsembleClassifier, FusionSettings, Mode, ModelRef, ModelSlot } from "../shared/settings";

export interface EngineConfig {
  mode: Mode;
  minWords: number;
  maxTokens: number;
  /** Active {repo, revision} for each slot the mode needs. */
  models: Partial<Record<ModelSlot, ModelRef>>;
  /** settings.useWebGPU: false forces WASM even when WebGPU is available. */
  allowWebGPU?: boolean;
  /** Legacy (v1): classifier the ensemble used. Ignored when `fusion` is set. */
  ensembleClassifier?: EnsembleClassifier;
  /** Fusion detector set and method (mode "ensemble"). */
  fusion?: FusionSettings;
  /** Calibration/dev builds only: per-slot WebGPU dtype overrides (see loader.loadModel). */
  webgpuDtypes?: Partial<Record<ModelSlot, DType>>;
  /** Page URL, if known (part of the result-cache key). */
  url?: string;
  /** Each block is a separate item (comment, review, snippet): scoring units never span two blocks. */
  itemBlocks?: boolean;
}

export interface CachedRepo extends ModelRef {
  bytes: number;
  files: number;
}

export interface HostOps {
  ping: { req: undefined; res: { ok: true; ts: number } };
  analyze: { req: { blocks: TextBlock[]; config: EngineConfig }; res: AnalyzeResult };
  /** Download (if needed), load and smoke-test one model. Used before switching revisions. */
  prepare: { req: { slot: ModelSlot; ref: ModelRef }; res: { device: string; dtype: string } };
  isCached: { req: { items: { slot: ModelSlot; ref: ModelRef }[] }; res: boolean[] };
  cacheInfo: { req: undefined; res: CachedRepo[] };
  deleteCache: { req: { refs: ModelRef[] }; res: { freedBytes: number } };
  unload: { req: { refs?: ModelRef[] }; res: { unloaded: number } };
  runtime: { req: undefined; res: EngineInfo["runtime"] };
}

export type HostOp = keyof HostOps;

export interface HostRequestEnvelope<O extends HostOp = HostOp> {
  kind: "lad-host-request";
  id: string;
  op: O;
  payload: HostOps[O]["req"];
}

export interface HostResponseEnvelope<O extends HostOp = HostOp> {
  kind: "lad-host-response";
  id: string;
  ok: boolean;
  result?: HostOps[O]["res"];
  error?: string;
}

export interface HostProgressEnvelope {
  kind: "lad-host-progress";
  id: string;
  progress: ProgressEvent;
}

export function isHostRequest(m: unknown): m is HostRequestEnvelope {
  return !!m && typeof m === "object" && (m as { kind?: unknown }).kind === "lad-host-request";
}

export function isHostResponse(m: unknown): m is HostResponseEnvelope {
  return !!m && typeof m === "object" && (m as { kind?: unknown }).kind === "lad-host-response";
}

export function isHostProgress(m: unknown): m is HostProgressEnvelope {
  return !!m && typeof m === "object" && (m as { kind?: unknown }).kind === "lad-host-progress";
}
