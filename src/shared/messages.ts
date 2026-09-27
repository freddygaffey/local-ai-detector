// Typed runtime-messaging contract, usable from content scripts, popup,
// options, background and the inference host (Chrome offscreen doc / Firefox
// worker, via the background as a relay). See docs/plan.md ("Shared
// contract"). Do not change message shapes without the lead's sign-off.
//
// Two kinds of traffic share `browser.runtime.sendMessage` /
// `browser.runtime.onMessage`:
//  - Request/response messages (below), sent with `sendMessage(type, payload)`
//    and handled with `registerHandlers({...})`.
//  - One-way progress events, broadcast during a long-running `analyze` call
//    and observed via the optional `onProgress` callback to `sendMessage`.

import { browser } from "wxt/browser";
import type { UnicodeScanResult } from "../detectors/unicode";
import type { HighlightStyle, Mode, ModelSlot } from "./settings";

export interface SentenceRange {
  start: number;
  end: number;
}

export interface TextBlock {
  id: string;
  text: string;
  sentences: SentenceRange[];
}

export interface AnalyzeRequest {
  tabId: number;
  mode: Mode;
  blocks: TextBlock[];
}

export type ScoreSource = "classifier" | "perplexity" | "binoculars";

export interface SentenceScore {
  blockId: string;
  index: number;
  /** 0..1, probability of AI authorship. */
  score: number;
  sources: Partial<Record<ScoreSource, number>>;
}

export type ProgressPhase = "download" | "load" | "analyze";

export interface ProgressEvent {
  phase: ProgressPhase;
  loaded: number;
  total: number;
  message: string;
}

/**
 * Added by T3: a minimal, optional shape for T4's provenance/watermark
 * summary (see docs/watermarks.md), so the popup can render a real one-line
 * summary once T4 fills it in, and a neutral placeholder until then.
 */
export interface ImageProvenanceSummary {
  total: number;
  withCredentials: number;
  withUnsignedClaim: number;
}

export interface AnalyzeResult {
  overall: number;
  sentences: SentenceScore[];
  unicode: UnicodeScanResult;
  tooLong?: boolean;
  notes: string[];
  /** Optional: set by T4 once provenance checks are wired into `analyze`. */
  images?: ImageProvenanceSummary;
}

export interface ModelUpdateInfo {
  slot: ModelSlot;
  repo: string;
  currentRevision: string;
  latestRevision: string;
  license: string | null;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

// ---- Discriminated union of request/response message kinds ----

export interface AnalyzeMessage {
  type: "analyze";
  request: AnalyzeRequest;
  response: AnalyzeResult;
}

export interface CheckModelUpdatesMessage {
  type: "checkModelUpdates";
  request: { slots?: ModelSlot[] } | undefined;
  response: ModelUpdateInfo[];
}

export interface UpdateModelMessage {
  type: "updateModel";
  request: { slot: ModelSlot };
  response: ActionResult;
}

export interface RollbackModelMessage {
  type: "rollbackModel";
  request: { slot: ModelSlot };
  response: ActionResult;
}

export interface SetCustomModelMessage {
  type: "setCustomModel";
  request: { slot: ModelSlot; repo: string };
  response: ({ ok: true; license: string | null } | { ok: false; error: string });
}

export interface DeleteCachedModelMessage {
  type: "deleteCachedModel";
  request: { slot: ModelSlot };
  response: ({ ok: true; freedBytes: number } | { ok: false; error: string });
}

export interface PingMessage {
  type: "ping";
  request: undefined;
  response: { ok: true; ts: number };
}

// ---- Added by T3 (additive only; see docs/plan.md "Shared contract") ----

/** Per-slot cache info, for the options page's model-management table and total cache size. */
export interface ModelSlotCacheInfo {
  cached: boolean;
  sizeBytes: number;
}

export interface GetModelCacheInfoMessage {
  type: "getModelCacheInfo";
  request: undefined;
  response: { slots: Partial<Record<ModelSlot, ModelSlotCacheInfo>>; totalBytes: number };
}

/**
 * Sent by the popup (via `sendTabMessage`, below) to the content script of
 * the active tab, asking it to extract text blocks to analyze. T2 owns the
 * handler; until it registers one, `sendTabMessage` rejects and the popup
 * shows its normal error state with retry.
 */
export interface ExtractTextMessage {
  type: "extractText";
  request: { target: "page" | "selection" };
  response: { blocks: TextBlock[] };
}

/**
 * Sent by the popup to the content script after `analyze` resolves, so it
 * can render highlights in the page. T2 owns the handler.
 */
export interface RenderHighlightsMessage {
  type: "renderHighlights";
  request: { result: AnalyzeResult; style: HighlightStyle };
  response: ActionResult;
}

/** Sent by the popup's "Clear highlights" button. T2 owns the handler. */
export interface ClearHighlightsMessage {
  type: "clearHighlights";
  request: undefined;
  response: ActionResult;
}

// ---- Added by T1 (additive only; see docs/plan.md "Shared contract") ----

/**
 * `analyze` rejects with an error whose message starts with this string when
 * the models for the requested mode aren't cached yet and the user hasn't
 * set `consentedDownload`. The rest of the message is human-readable.
 */
export const CONSENT_REQUIRED_ERROR = "consent-required";

/** Result of checking a user-entered Hugging Face repo for a model slot, without switching to it. */
export type CustomModelValidation =
  | {
      ok: true;
      repo: string;
      /** Commit SHA that would be pinned. */
      revision: string;
      license: string | null;
      /** False for missing/"other"/non-open licences: show a visible warning. */
      openLicense: boolean;
      /** Human-readable warnings (licence, no WebGPU weights, tokenizer mismatch, ...). */
      warnings: string[];
      /** Approximate download size (q8 weights + tokenizer), if known. */
      sizeBytes: number | null;
    }
  | { ok: false; error: string };

export interface ValidateCustomModelMessage {
  type: "validateCustomModel";
  request: { slot: ModelSlot; repo: string };
  response: CustomModelValidation;
}

/** Latest analysis state per tab, kept by the background router. */
export type TabAnalysisStatus =
  | { state: "idle" }
  | { state: "running"; mode: Mode; progress?: ProgressEvent }
  | { state: "done"; mode: Mode; result: AnalyzeResult; finishedAt: number }
  | { state: "error"; mode: Mode; error: string };

export interface GetTabStatusMessage {
  type: "getTabStatus";
  request: { tabId: number };
  response: TabAnalysisStatus;
}

/** Inference-host facts plus the last model-update check, for the options page. */
export interface EngineInfo {
  runtime: {
    device: "webgpu" | "wasm" | "cpu";
    shaderF16: boolean;
    threads: number;
    crossOriginIsolated: boolean;
    cache: "cache-api" | "indexeddb" | "filesystem" | "none";
    persisted: boolean | null;
  } | null;
  lastUpdateCheck: { ts: number; updates: ModelUpdateInfo[] } | null;
}

export interface GetEngineInfoMessage {
  type: "getEngineInfo";
  request: undefined;
  response: EngineInfo;
}

/**
 * One-way event broadcast by the background whenever a tab's analysis state
 * changes (to extension pages via runtime.sendMessage, and to that tab's
 * content script via tabs.sendMessage), so the popup and the page can follow
 * an analysis they didn't start themselves.
 */
export interface AnalysisStatusEnvelope {
  kind: "event";
  event: "analysisStatus";
  tabId: number;
  status: TabAnalysisStatus;
}

export function isAnalysisStatusEnvelope(m: unknown): m is AnalysisStatusEnvelope {
  return (
    !!m &&
    typeof m === "object" &&
    (m as { kind?: unknown }).kind === "event" &&
    (m as { event?: unknown }).event === "analysisStatus"
  );
}

/** Subscribes to analysisStatus events. Returns an unsubscribe function. */
export function onAnalysisStatus(callback: (tabId: number, status: TabAnalysisStatus) => void): () => void {
  const listener = (message: unknown) => {
    if (isAnalysisStatusEnvelope(message)) callback(message.tabId, message.status);
    return undefined;
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}

/** Every request/response message kind, as a discriminated union. */
export type RuntimeMessage =
  | ValidateCustomModelMessage
  | GetTabStatusMessage
  | GetEngineInfoMessage
  | AnalyzeMessage
  | CheckModelUpdatesMessage
  | UpdateModelMessage
  | RollbackModelMessage
  | SetCustomModelMessage
  | DeleteCachedModelMessage
  | PingMessage
  | GetModelCacheInfoMessage
  | ExtractTextMessage
  | RenderHighlightsMessage
  | ClearHighlightsMessage;

export type MessageType = RuntimeMessage["type"];

export type RequestOf<T extends MessageType> = Extract<RuntimeMessage, { type: T }>["request"];
export type ResponseOf<T extends MessageType> = Extract<RuntimeMessage, { type: T }>["response"];

// ---- Wire format ----

interface RequestEnvelope<T extends MessageType = MessageType> {
  kind: "request";
  id: string;
  type: T;
  payload: RequestOf<T>;
}

interface ResponseEnvelope<T extends MessageType = MessageType> {
  kind: "response";
  id: string;
  type: T;
  ok: boolean;
  payload?: ResponseOf<T>;
  error?: string;
}

interface ProgressEnvelope {
  kind: "event";
  event: "progress";
  requestId: string;
  progress: ProgressEvent;
}

type WireMessage = RequestEnvelope | ResponseEnvelope | ProgressEnvelope;

function isRequestEnvelope(m: unknown): m is RequestEnvelope {
  return !!m && typeof m === "object" && (m as { kind?: unknown }).kind === "request";
}

function isProgressEnvelope(m: unknown): m is ProgressEnvelope {
  return (
    !!m &&
    typeof m === "object" &&
    (m as { kind?: unknown }).kind === "event" &&
    (m as { event?: unknown }).event === "progress"
  );
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sends a typed request and awaits its typed response. If `onProgress` is
 * given, it is invoked for every `progress` event broadcast with a matching
 * request id while the call is outstanding (e.g. model download/analyze
 * phases for a single `analyze` call).
 */
export async function sendMessage<T extends MessageType>(
  type: T,
  payload: RequestOf<T>,
  onProgress?: (progress: ProgressEvent) => void,
): Promise<ResponseOf<T>> {
  const id = newId();
  const progressListener = onProgress
    ? (message: unknown) => {
        if (isProgressEnvelope(message) && message.requestId === id) {
          onProgress(message.progress);
        }
      }
    : undefined;
  if (progressListener) browser.runtime.onMessage.addListener(progressListener);
  try {
    const request: RequestEnvelope<T> = { kind: "request", id, type, payload };
    const res = (await browser.runtime.sendMessage(request)) as ResponseEnvelope<T> | undefined;
    if (!res) throw new Error(`No response for message "${type}"`);
    if (!res.ok) throw new Error(res.error ?? `Message "${type}" failed`);
    return res.payload as unknown as ResponseOf<T>;
  } finally {
    if (progressListener) browser.runtime.onMessage.removeListener(progressListener);
  }
}

/**
 * Like `sendMessage`, but targets a specific tab's content script via
 * `browser.tabs.sendMessage` instead of the extension-wide
 * `browser.runtime.sendMessage`. Used by the popup (T3) to talk to the
 * content script (T2), which can register handlers for these message types
 * with the same `registerHandlers` (it listens on `runtime.onMessage`, which
 * also receives messages sent via `tabs.sendMessage`).
 */
export async function sendTabMessage<T extends MessageType>(
  tabId: number,
  type: T,
  payload: RequestOf<T>,
): Promise<ResponseOf<T>> {
  const id = newId();
  const request: RequestEnvelope<T> = { kind: "request", id, type, payload };
  const res = (await browser.tabs.sendMessage(tabId, request)) as ResponseEnvelope<T> | undefined;
  if (!res) throw new Error(`No response for tab message "${type}"`);
  if (!res.ok) throw new Error(res.error ?? `Tab message "${type}" failed`);
  return res.payload as unknown as ResponseOf<T>;
}

/** Broadcasts a progress event tied to `requestId` (the id `sendMessage` generated). */
export function sendProgress(requestId: string, progress: ProgressEvent): void {
  const message: ProgressEnvelope = { kind: "event", event: "progress", requestId, progress };
  void browser.runtime.sendMessage(message).catch(() => {
    // No listener (e.g. the tab that started the request went away). Fine to ignore.
  });
}

interface HandlerMeta {
  senderTabId?: number;
  requestId: string;
}

type Handler<T extends MessageType> = (
  payload: RequestOf<T>,
  meta: HandlerMeta,
) => ResponseOf<T> | Promise<ResponseOf<T>>;

export type Handlers = { [T in MessageType]?: Handler<T> };

/**
 * Registers request handlers on `browser.runtime.onMessage`. Uses the
 * promise-returning listener style (works uniformly on Chrome and Firefox via
 * the `wxt/browser` polyfill) rather than `sendResponse` + `return true`.
 * Returns an unsubscribe function.
 */
export function registerHandlers(handlers: Handlers): () => void {
  const listener = (message: unknown, sender: { tab?: { id?: number } }) => {
    if (!isRequestEnvelope(message)) return undefined;
    const handler = handlers[message.type as MessageType] as Handler<MessageType> | undefined;
    if (!handler) return undefined;
    return Promise.resolve(handler(message.payload, { senderTabId: sender.tab?.id, requestId: message.id }))
      .then((payload): ResponseEnvelope => ({ kind: "response", id: message.id, type: message.type, ok: true, payload }))
      .catch((err: unknown): ResponseEnvelope => ({
        kind: "response",
        id: message.id,
        type: message.type,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }));
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
