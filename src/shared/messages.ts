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
import type { Mode, ModelSlot } from "./settings";

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

export interface AnalyzeResult {
  overall: number;
  sentences: SentenceScore[];
  unicode: UnicodeScanResult;
  tooLong?: boolean;
  notes: string[];
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

/** Every request/response message kind, as a discriminated union. */
export type RuntimeMessage =
  | AnalyzeMessage
  | CheckModelUpdatesMessage
  | UpdateModelMessage
  | RollbackModelMessage
  | SetCustomModelMessage
  | DeleteCachedModelMessage
  | PingMessage;

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
