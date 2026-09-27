// Getting a YouTube transcript from what the page already has (docs/plan.md
// "Phase 2: T10"). Nothing here talks to anything but youtube.com itself,
// and nothing new leaves the device:
//
// 1. The transcript panel, only if the user already has it open.
// 2. The player's own caption track, read by the page-world helper
//    (./pageCaptions.ts): the only source that still works in a real
//    browser (bare timedtext URLs now come back empty without the player's
//    token, and a hidden transcript panel never loads). Watch pages and
//    Shorts alike.
//
// Whether a video has captions at all comes from the player's track list
// (and, as a fallback, its CC button).

import { looksUnpunctuated, parseCaptionPayload, parsePanelSegments, type Cue, type Transcript } from "./transcript";
import { CAPTIONS_REQUEST, CAPTIONS_RESPONSE, type CaptionsRequest, type CaptionsResponse, type CaptionsResult } from "./pageCaptions";

/** "page": not YouTube -- a page video's <track> or a subtitle page (src/content/pageMedia.ts). */
export type VideoKind = "watch" | "shorts" | "page";

export interface VideoRef {
  videoId: string;
  kind: VideoKind;
}

export function isYouTubeHost(hostname: string): boolean {
  return /(^|\.)youtube\.com$/.test(hostname) && !/^(music|studio|tv)\./.test(hostname);
}

/** The video this page is showing, from its URL. */
export function videoFromUrl(href: string): VideoRef | null {
  try {
    const u = new URL(href);
    if (!isYouTubeHost(u.hostname)) return null;
    if (u.pathname === "/watch") {
      const v = u.searchParams.get("v");
      return v ? { videoId: v, kind: "watch" } : null;
    }
    const m = u.pathname.match(/^\/shorts\/([\w-]{6,})/);
    return m ? { videoId: m[1]!, kind: "shorts" } : null;
  } catch {
    return null;
  }
}

export interface CaptionTrackInfo {
  languageCode: string;
  kind?: string;
  name?: string;
}

/**
 * Caption tracks from the page's inline `ytInitialPlayerResponse`, only when
 * it belongs to `videoId` (after in-app navigation it describes the first
 * video, so it's ignored). null = unknown.
 */
export function inlineCaptionTracks(doc: Document, videoId: string): CaptionTrackInfo[] | null {
  try {
    for (const s of Array.from(doc.scripts)) {
      const text = s.textContent ?? "";
      const at = text.indexOf("ytInitialPlayerResponse");
      if (at < 0) continue;
      const vid = text.slice(at).match(/"videoDetails":\{"videoId":"([\w-]+)"/)?.[1];
      if (vid !== videoId) return null;
      const m = text.slice(at).match(/"captionTracks":(\[.*?\])\s*,\s*"audioTracks"/) ?? text.slice(at).match(/"captionTracks":(\[.*?\}\])/);
      if (!m) return [];
      const tracks = JSON.parse(m[1]!) as Array<{ languageCode?: string; kind?: string; name?: { simpleText?: string } }>;
      return tracks.map((t) => ({ languageCode: t.languageCode ?? "", kind: t.kind, name: t.name?.simpleText }));
    }
  } catch {
    // unknown
  }
  return null;
}

/** False when the visible player's CC button says captions are unavailable; null when unknown. */
export function playerHasCaptions(doc: Document): boolean | null {
  const btns = Array.from(doc.querySelectorAll(".ytp-subtitles-button")).filter((b) => (b as HTMLElement).getClientRects?.().length);
  const b = btns[0] ?? doc.querySelector(".ytp-subtitles-button");
  if (!b) return null;
  const label = `${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("data-title-no-tooltip") ?? ""}`;
  if (/unavailable/i.test(label)) return false;
  return (b as HTMLElement).style?.display === "none" ? false : true;
}

const EXPANDED = 'ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]';
const SEGMENT = "transcript-segment-view-model, ytd-transcript-segment-renderer";

/** Cues from a transcript panel that is already open (never touches the page). */
export function readOpenPanel(doc: Document): Cue[] {
  for (const panel of Array.from(doc.querySelectorAll(EXPANDED))) {
    if (panel.querySelector(SEGMENT)) return parsePanelSegments(panel);
  }
  return [];
}

export function transcriptButton(doc: Document): HTMLElement | null {
  const btns = Array.from(doc.querySelectorAll<HTMLElement>("ytd-video-description-transcript-section-renderer button"));
  return btns.find((b) => b.isConnected) ?? null;
}

/** /api/timedtext URLs the player has already requested for this video, newest first. */
export function loadedCaptionUrls(videoId: string, perf: Pick<Performance, "getEntriesByType"> = performance): string[] {
  const urls: string[] = [];
  for (const e of perf.getEntriesByType("resource")) {
    try {
      const u = new URL(e.name);
      if (u.pathname === "/api/timedtext" && isYouTubeHost(u.hostname) && u.searchParams.get("v") === videoId) urls.push(e.name);
    } catch {
      // ignore
    }
  }
  return urls.reverse();
}

export type Acquired =
  | { status: "ok"; transcript: Transcript }
  /** The video has no captions / transcript. */
  | { status: "none" }
  /** Has (or may have) one, but reading it failed. */
  | { status: "unavailable" };

let reqCounter = 0;

/**
 * Asks the page-world helper (./pageCaptions.ts, injected by
 * entrypoints/youtube-main.content.ts) for this video's captions.
 */
export function requestPageCaptions(videoId: string, timeoutMs = 15000): Promise<CaptionsResult> {
  return new Promise((resolve) => {
    const id = `c${Date.now().toString(36)}-${++reqCounter}`;
    const finish = (r: CaptionsResult) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      resolve(r);
    };
    const onMsg = (e: MessageEvent) => {
      const d = e.data as Partial<CaptionsResponse> | null;
      if (!d || d.source !== CAPTIONS_RESPONSE || d.id !== id) return;
      if (d.status === "ok" && typeof d.body === "string") finish({ status: "ok", body: d.body, language: String(d.language ?? ""), auto: d.auto === true });
      else if (d.status === "none") finish({ status: "none" });
      else finish({ status: "error", error: String((d as { error?: unknown }).error ?? "failed") });
    };
    const timer = setTimeout(() => finish({ status: "error", error: "timeout" }), timeoutMs);
    window.addEventListener("message", onMsg);
    window.postMessage({ source: CAPTIONS_REQUEST, id, videoId } satisfies CaptionsRequest, location.origin);
  });
}

/** True while the player is showing an ad (pre-roll / mid-roll). */
export function adShowing(doc: Document): boolean {
  return !!doc.querySelector("#movie_player.ad-showing, #shorts-player.ad-showing");
}

/**
 * Waits (up to `maxMs`) for an ad to finish. During an ad the player
 * reports the ad's captions (none) and hides the CC button, which used to
 * read as "No transcript" for the real video.
 */
export async function waitForAdEnd(doc: Document, maxMs = 180_000, stepMs = 1000): Promise<void> {
  for (let t = 0; t < maxMs && adShowing(doc); t += stepMs) await new Promise((r) => setTimeout(r, stepMs));
}

export async function acquireTranscript(
  doc: Document,
  video: VideoRef,
  deps: { pageCaptions?: typeof requestPageCaptions } = {},
): Promise<Acquired> {
  await waitForAdEnd(doc);
  const describe = (cues: Cue[], source: Transcript["source"], language?: string, auto?: boolean): Acquired => ({
    status: "ok",
    transcript: { videoId: video.videoId, cues, source, language, autoGenerated: auto ?? looksUnpunctuated(cues) },
  });
  // A transcript panel the user already has open: read it as is.
  if (video.kind === "watch") {
    const open = readOpenPanel(doc);
    if (open.length > 0) return describe(open, "panel");
  }
  // The player's own caption track, via the page-world helper.
  const got = await (deps.pageCaptions ?? requestPageCaptions)(video.videoId);
  if (got.status === "none") return { status: "none" };
  if (got.status === "ok") {
    const cues = parseCaptionPayload(got.body);
    if (cues.length > 0) return describe(cues, "captions", got.language || undefined, got.auto);
  }
  return playerHasCaptions(doc) === false ? { status: "none" } : { status: "unavailable" };
}

// ---- YouTube's own disclosure label ----------------------------------------

/**
 * YouTube's creator disclosure ("How this was made" -> "Made with AI" /
 * "Altered or synthetic content"), when the page shows one. Auto-dubbing
 * notes are YouTube's own processing, not a content disclosure, and are skipped.
 */
export function readDisclosure(doc: Document, scope?: Element | null): string | null {
  const root: ParentNode = scope ?? doc;
  for (const el of Array.from(root.querySelectorAll("how-this-was-made-section-view-model"))) {
    const header = el.querySelector('[class*="BodyHeader"]')?.textContent?.trim() ?? "";
    const body = el.querySelector('[class*="BodyText"]')?.textContent?.trim() ?? "";
    const label = header || body;
    if (/altered|synthetic|made with ai|ai[- ]generated|digitally generated|fully generated/i.test(`${header} ${body}`) && !/dubb/i.test(header)) {
      return label.replace(/\s+/g, " ").slice(0, 80);
    }
  }
  // Older markup and the Shorts overlay: a short label with this exact text.
  for (const el of Array.from(root.querySelectorAll("ytd-watch-metadata *, ytd-reel-video-renderer[is-active] *, #description *"))) {
    if (el.children.length) continue;
    const t = el.textContent?.trim() ?? "";
    if (/^(altered or synthetic content|made with ai)$/i.test(t)) return t;
  }
  return null;
}
