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
import type {
  ProvenanceHostRequest,
  ProvenanceHostResponse,
  ProvenanceScanImagesRequest,
  ProvenanceScanImagesResponse,
  ProvenanceVerifyTextRequest,
  TextProvenanceResult,
} from "../provenance/types";
import type { FusionDetector, FusionMethod, HighlightStyle, Mode, ModelSlot } from "./settings";

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
 * Page-level summary of the image provenance checks (src/provenance), built
 * by `summarizeImageResults()` in the content script after its image scan
 * and merged into the tab's `done` status by the background (see
 * `reportImageSummary`). Counts are over images actually checked.
 */
export interface ImageProvenanceSummary {
  /** Images found on the page and sent for checking (including ones awaiting permission). */
  total: number;
  /** Images whose bytes were actually checked. */
  checked: number;
  /** Images with a C2PA manifest (Content Credentials), trusted or not. */
  withCredentials: number;
  /** ... of which the signer chains to the bundled C2PA Trust List. */
  trustedCredentials: number;
  /** Images with any signal that says AI-generated or AI-edited. */
  aiSignals: number;
  /** Images with an unsigned AI-generator claim in metadata. */
  withUnsignedClaim: number;
  /** Images with an open-source invisible watermark (SD/SDXL/FLUX) or NovelAI stealth data. */
  withWatermark: number;
  /** Origin patterns that still need the optional host permission. */
  permissionNeeded: string[];
  /** settings.checkImages is off. */
  disabled?: boolean;
}

export interface AnalyzeResult {
  overall: number;
  sentences: SentenceScore[];
  unicode: UnicodeScanResult;
  tooLong?: boolean;
  notes: string[];
  /** Set after the content script's image scan finishes (see `reportImageSummary`). */
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
  // "editable": T9's "Check text in this box" context menu -- the input,
  // textarea or contenteditable element under the click.
  request: { target: "page" | "selection" | "editable" };
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

// ---- Added by T4 (additive only; see docs/plan.md "Shared contract") ----
// Provenance & watermarks. Shapes live in src/provenance/types.ts.

/**
 * Content script -> background: check images for C2PA / metadata /
 * invisible watermarks. The background checks settings.checkImages and the
 * optional host permission per origin, then runs the checks in the
 * provenance host (Chrome offscreen doc / Firefox event page).
 */
export interface ProvenanceScanImagesMessage {
  type: "provenanceScanImages";
  request: ProvenanceScanImagesRequest;
  response: ProvenanceScanImagesResponse;
}

/** Background -> Chrome offscreen document (internal relay; not for UI use). */
export interface ProvenanceHostAnalyzeMessage {
  type: "provenanceHostAnalyze";
  request: ProvenanceHostRequest;
  response: ProvenanceHostResponse;
}

/**
 * Content/popup -> background: try to verify the signature of a C2PA text
 * manifest extracted with `detectTextProvenance()` (src/provenance/text.ts).
 */
export interface ProvenanceVerifyTextMessage {
  type: "provenanceVerifyText";
  request: ProvenanceVerifyTextRequest;
  response: TextProvenanceResult;
}

/** Background -> Chrome offscreen document (internal relay; not for UI use). */
export interface ProvenanceHostVerifyTextMessage {
  type: "provenanceHostVerifyText";
  request: ProvenanceVerifyTextRequest;
  response: TextProvenanceResult;
}

// ---- Added by T5: one background-orchestrated analysis path ----

/**
 * Popup / pill / autoRun -> background: analyze a tab end to end. The
 * background asks the tab's content script for the text (`extractText`,
 * injecting the content script first if the tab predates the extension),
 * runs `analyze`, then sends `renderHighlights` back. The context menu uses
 * the same path. `tabId` is ignored for content-script senders (their own
 * tab is used). Progress/state reach every observer through
 * `analysisStatus` events.
 */
export interface AnalyzeTabMessage {
  type: "analyzeTab";
  request: { tabId?: number; target: "page" | "selection" } & AnalyzeTabRequestT7;
  response: AnalyzeResult;
}

/** Content script -> background: the page's image provenance summary, merged into the tab status. */
export interface ReportImageSummaryMessage {
  type: "reportImageSummary";
  request: { summary: ImageProvenanceSummary };
  response: ActionResult;
}

/** Popup -> content script: (re)scan the page's images, e.g. after a permission grant. */
export interface ScanImagesMessage {
  type: "scanImages";
  request: undefined;
  response: ImageProvenanceSummary;
}

// ---- Added by T7: Fusion, agreement, device, calibrated probability ----
// Additive (interface merging): older results simply lack these fields.

/** How many detectors agree with the combined verdict (flagged vs not flagged). */
export interface Agreement {
  /** Detectors whose own verdict matches the combined one. */
  agree: number;
  /** Detectors that produced a score for this text. */
  total: number;
  /** True when the detectors split badly (under 2/3 agree, or their scores are >= 0.5 apart): low confidence. */
  disagree: boolean;
}

/** One detector's part in an analysis. */
export interface DetectorRun {
  id: FusionDetector;
  /** Short UI label, e.g. "TMR", "ModernBERT", "Perplexity". */
  label: string;
  /** This detector's own overall score (same 0..1 scale as `AnalyzeResult.overall`). */
  overall: number;
  /** Where it ran. */
  device: "webgpu" | "wasm" | "cpu";
  /** Weights it ran with, e.g. "fp16", "q8". */
  dtype: string;
  /** Its weight in the "weighted" combination (1 for the other methods). */
  weight: number;
}

export interface SentenceScore {
  /** Each detector's score for this sentence (its paragraph-level unit). Only with 2+ detectors. */
  detectors?: Partial<Record<FusionDetector, number>>;
  /** Only with 2+ detectors. */
  agreement?: Agreement;
}

export interface AnalyzeResult {
  /**
   * Calibrated probability that the text is AI-generated, for display
   * ("AI 91%"): fitted on held-out web text for this detector set, device
   * and text length (see `toDisplayProbability` in ./thresholds.ts and
   * docs/calibration.md). Undefined below `MIN_WORDS_FOR_SCORE` words:
   * show "—" instead of a number.
   */
  probability?: number;
  /** Words actually analysed (after the maxTokens cap). */
  words?: number;
  /** "mixed" when some detectors ran on WebGPU and some on WASM (e.g. Binoculars). */
  device?: "webgpu" | "wasm" | "cpu" | "mixed";
  /** Detectors that ran, in order. */
  detectors?: DetectorRun[];
  /** Fusion only (2+ detectors): method and overall agreement. */
  fusion?: { method: FusionMethod; agreement: Agreement };
}

export interface AnalyzeTabRequestT7 {
  /**
   * Detector mode for this run, e.g. `settings.autoRunFastMode` for the
   * automatic pass. Defaults to `settings.mode` (the full Fusion).
   */
  mode?: Mode;
}

// ---- Added by T9 (additive only; see docs/plan.md "Shared contract") ----

/**
 * Background -> engine (best-effort): unload models from memory after
 * `Settings.battery.unloadAfterMinutes` idle. src/power/idle.ts times this;
 * the engine (T7) may not implement a handler yet, in which case this simply
 * gets no response and is treated as a no-op (see src/power's caller).
 */
export interface UnloadIdleModelsMessage {
  type: "unloadIdleModels";
  request: undefined;
  response: ActionResult;
}

/**
 * Background -> the tab's content script: check one image (by its resolved
 * src) regardless of its displayed size, for the "Check image for Content
 * Credentials & watermarks" context-menu entry. T9's handler
 * (src/content/imageContextCheck.ts) renders the result as a normal badge.
 */
export interface CheckImageAtUrlMessage {
  type: "checkImageAtUrl";
  request: { srcUrl: string };
  response: ActionResult;
}

/**
 * Popup -> content script: the "On click" preset's "Show on page" button --
 * turns the pill + highlights on for this visit only (never persisted).
 */
export interface ShowOnPageMessage {
  type: "showOnPage";
  request: undefined;
  response: ActionResult;
}

/** Background (toggle-visibility command) -> content script: shows the pill/highlights if hidden, hides them if shown. */
export interface ToggleVisibilityMessage {
  type: "toggleVisibility";
  request: undefined;
  response: ActionResult;
}

/** Side panel -> content script: scroll to and briefly flash one sentence, without turning highlights on. */
export interface ScrollToSentenceMessage {
  type: "scrollToSentence";
  request: { blockId: string; index: number };
  response: ActionResult;
}

// ---- Added by T12: popup selection check (additive only) ----

/**
 * Popup -> content script, on popup open: is there a non-empty text
 * selection on the page right now? Drives dimming "Analyze selection" with
 * a tooltip instead of letting the user hit a full error state
 * (docs/integration-notes.md "For T12", user feedback preview).
 */
export interface GetSelectionInfoMessage {
  type: "getSelectionInfo";
  request: undefined;
  response: { hasSelection: boolean };
}

/** Every request/response message kind, as a discriminated union. */
export type RuntimeMessage =
  | UnloadIdleModelsMessage
  | CheckImageAtUrlMessage
  | ShowOnPageMessage
  | ToggleVisibilityMessage
  | ScrollToSentenceMessage
  | GetSelectionInfoMessage
  | AnalyzeTabMessage
  | ReportImageSummaryMessage
  | ScanImagesMessage
  | ProvenanceScanImagesMessage
  | ProvenanceHostAnalyzeMessage
  | ProvenanceVerifyTextMessage
  | ProvenanceHostVerifyTextMessage
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

/**
 * The tab id of a content-script sender. Undefined for extension pages, even
 * when one is open in a tab (e.g. the popup or options page loaded as a
 * tab), so their explicit `tabId` isn't overridden by their own tab.
 */
function contentScriptTabId(sender: { tab?: { id?: number }; url?: string }): number | undefined {
  if (sender.tab?.id === undefined) return undefined;
  try {
    const own = browser.runtime.getURL("/" as "/");
    if (sender.url && sender.url.startsWith(own)) return undefined;
  } catch {
    // no runtime (tests): fall through
  }
  return sender.tab.id;
}

interface HandlerMeta {
  /** Tab id of the sending content script (undefined for extension pages). */
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
  const listener = (message: unknown, sender: { tab?: { id?: number }; url?: string }) => {
    if (!isRequestEnvelope(message)) return undefined;
    const handler = handlers[message.type as MessageType] as Handler<MessageType> | undefined;
    if (!handler) return undefined;
    return Promise.resolve(handler(message.payload, { senderTabId: contentScriptTabId(sender), requestId: message.id }))
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
