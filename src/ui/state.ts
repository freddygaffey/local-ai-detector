// Popup state machine and "can we even run here" detection. Pure and
// framework-free so it's unit-testable without a real browser.

import type { AnalyzeResult, ProgressEvent } from "../shared/messages";
import { classifyUrl, parseUnreadable, type UnreadableKind } from "../shared/unreadable";

export type PopupState =
  | "consent"
  | "unsupported"
  | "idle"
  | "downloading"
  | "loading"
  | "analyzing"
  | "done"
  | "error";

export interface PopupStateInput {
  consentedDownload: boolean;
  tabUrl: string | null | undefined;
  progress: ProgressEvent | null;
  result: AnalyzeResult | null;
  error: string | null;
  /** From probing the tab (a PDF served without ".pdf", a protected page). */
  unreadable?: UnreadableKind | null;
}

/** Derives the popup's current state from settings + in-flight/last-known data.
 * Kept as one pure function so every screen the popup can be in is a single,
 * testable decision instead of scattered flags. */
export function derivePopupState(input: PopupStateInput): PopupState {
  if (!input.consentedDownload) return "consent";
  const unreadableError = !!input.error && parseUnreadable(input.error) !== null;
  const unsupported = isUnsupportedUrl(input.tabUrl) || !!input.unreadable || unreadableError;
  // A PDF can still get a result: "Check selected text" analyses the menu's own
  // selection text in the background, so progress and results show as usual.
  if (unsupported && !input.progress && !input.result) return "unsupported";
  if (input.error && !unreadableError) return "error";
  if (input.progress) {
    if (input.progress.phase === "download") return "downloading";
    if (input.progress.phase === "load") return "loading";
    return "analyzing";
  }
  if (input.result) return "done";
  return "idle";
}

/** True for pages we can't (or shouldn't try to) inject a content script into:
 * browser-internal pages, extension store listings, and PDF viewers. */
export function isUnsupportedUrl(url: string | null | undefined): boolean {
  return classifyUrl(url) !== null;
}

/**
 * No known total during a "download" phase almost always means the model
 * came straight from cache -- a real network fetch reports a byte total
 * quickly. Cache reads never say "Downloading" (persona-walkthrough
 * finding: it was misleading users into thinking they were re-fetching).
 * Mirrors entrypoints/popup/main.ts's `isCacheLoad`.
 */
export function isCacheLoad(progress: ProgressEvent): boolean {
  return progress.phase === "download" && progress.total === 0;
}

export function progressLabel(progress: ProgressEvent): string {
  switch (progress.phase) {
    case "download":
      return isCacheLoad(progress) ? "Loading model" : "Downloading model";
    case "load":
      return "Loading model";
    case "analyze":
      return "Analyzing";
  }
}

/** 0..100, or null when the total is unknown (indeterminate progress bar). */
export function progressPercent(progress: ProgressEvent): number | null {
  if (!progress.total || progress.total <= 0) return null;
  return Math.min(100, Math.round((progress.loaded / progress.total) * 100));
}
