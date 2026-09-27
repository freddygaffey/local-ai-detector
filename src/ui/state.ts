// Popup state machine and "can we even run here" detection. Pure and
// framework-free so it's unit-testable without a real browser.

import type { AnalyzeResult, ProgressEvent } from "../shared/messages";

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
}

/** Derives the popup's current state from settings + in-flight/last-known data.
 * Kept as one pure function so every screen the popup can be in is a single,
 * testable decision instead of scattered flags. */
export function derivePopupState(input: PopupStateInput): PopupState {
  if (!input.consentedDownload) return "consent";
  if (isUnsupportedUrl(input.tabUrl)) return "unsupported";
  if (input.error) return "error";
  if (input.progress) {
    if (input.progress.phase === "download") return "downloading";
    if (input.progress.phase === "load") return "loading";
    return "analyzing";
  }
  if (input.result) return "done";
  return "idle";
}

const UNSUPPORTED_PROTOCOLS = new Set([
  "chrome:",
  "chrome-extension:",
  "edge:",
  "about:",
  "moz-extension:",
  "view-source:",
  "devtools:",
  "chrome-search:",
  "chrome-error:",
]);

const UNSUPPORTED_HOSTS = [
  /^chrome\.google\.com$/,
  /^chromewebstore\.google\.com$/,
  /^addons\.mozilla\.org$/,
  /^microsoftedge\.microsoft\.com$/,
];

/** True for pages we can't (or shouldn't try to) inject a content script into:
 * browser-internal pages, extension store listings, and PDF viewers. */
export function isUnsupportedUrl(url: string | null | undefined): boolean {
  if (!url) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (UNSUPPORTED_PROTOCOLS.has(parsed.protocol)) return true;
  if (parsed.protocol === "file:" && parsed.pathname.toLowerCase().endsWith(".pdf")) return true;
  if (UNSUPPORTED_HOSTS.some((re) => re.test(parsed.hostname))) return true;
  // Chrome/Edge's built-in PDF viewer serves the file at its normal http(s)
  // URL but as application/pdf; the URL itself is the only signal we have
  // without asking the tab, so also catch plain ".pdf" paths.
  if (/\.pdf($|[?#])/i.test(parsed.pathname)) return true;
  return false;
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
