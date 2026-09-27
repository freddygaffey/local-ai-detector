// Getting a YouTube transcript from what the page already has (docs/plan.md
// "Phase 2: T10"). Nothing here talks to anything but youtube.com itself,
// and nothing new leaves the device:
//
// 1. The transcript panel. If it's already open, it's read as is. Otherwise
//    the description's own "Show transcript" button is clicked with the
//    panel hidden by a temporary style (so the page doesn't flicker), the
//    segments are read, and the panel is closed again. This is exactly what
//    YouTube does when the user opens the panel.
// 2. The caption track the player already loaded (/api/timedtext, listed in
//    the page's resource timing): re-read from the same URL. Used on Shorts,
//    which have no transcript panel, and when the panel is missing.
//
// Whether a video has captions at all comes from the page's inline player
// response (valid for the first video loaded) and the player's CC button.

import { looksUnpunctuated, parseCaptionPayload, parsePanelSegments, type Cue, type Transcript } from "./transcript";

export type VideoKind = "watch" | "shorts";

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
const HIDE_ATTR = "data-ai-detector-hidden";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function signature(root: ParentNode): string {
  const segs = Array.from(root.querySelectorAll(SEGMENT));
  return `${segs.length}|${segs.slice(0, 3).map((s) => s.textContent ?? "").join("|")}`;
}

/**
 * Opens the transcript panel hidden, reads it, and closes it again. Returns
 * [] when there's no "Show transcript" button or nothing loaded in time.
 */
export async function openPanelAndRead(doc: Document, timeoutMs = 8000): Promise<Cue[]> {
  const btn = transcriptButton(doc);
  if (!btn) return [];
  const before = new Set(Array.from(doc.querySelectorAll(EXPANDED)));
  const staleSig = signature(doc);
  const style = doc.createElement("style");
  style.textContent = `ytd-engagement-panel-section-list-renderer[${HIDE_ATTR}]{display:none!important}`;
  (doc.head ?? doc.documentElement).appendChild(style);
  const hideNew = () => {
    for (const p of Array.from(doc.querySelectorAll(EXPANDED))) if (!before.has(p)) p.setAttribute(HIDE_ATTR, "");
  };
  const mo = new MutationObserver(hideNew);
  mo.observe(doc.documentElement, { subtree: true, attributes: true, attributeFilter: ["visibility"] });
  const focused = doc.activeElement as HTMLElement | null;
  const scroll = { x: window.scrollX, y: window.scrollY };
  let opened: Element[] = [];
  try {
    btn.click();
    hideNew();
    let last = "";
    let stable = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(200);
      opened = Array.from(doc.querySelectorAll(EXPANDED)).filter((p) => !before.has(p));
      const panel = opened.find((p) => p.querySelector(SEGMENT));
      if (!panel) continue;
      const sig = signature(panel);
      // After in-app navigation the panel can still hold the previous
      // video's segments for a moment; wait for new ones (or a short grace).
      if (sig === staleSig && Date.now() - t0 < 2500) continue;
      if (sig === last) {
        if (++stable >= 2) break;
      } else {
        stable = 0;
        last = sig;
      }
    }
    const panel = opened.find((p) => p.querySelector(SEGMENT));
    return panel ? parsePanelSegments(panel) : [];
  } finally {
    for (const p of opened) {
      const close = p.querySelector<HTMLElement>('#visibility-button button, button[aria-label="Close"]');
      if (close) close.click();
      else p.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    }
    mo.disconnect();
    try {
      window.scrollTo(scroll.x, scroll.y);
      focused?.focus?.({ preventScroll: true });
    } catch {
      // ignore
    }
    // Keep the panel hidden until its close has rendered.
    setTimeout(() => {
      for (const p of Array.from(doc.querySelectorAll(`[${HIDE_ATTR}]`))) p.removeAttribute(HIDE_ATTR);
      style.remove();
    }, 400);
  }
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

/** The caption track the player already loaded, re-read from the same same-origin URL. */
export async function readLoadedCaptions(videoId: string): Promise<{ cues: Cue[]; language?: string; auto?: boolean }> {
  for (const url of loadedCaptionUrls(videoId)) {
    try {
      const u = new URL(url);
      if (u.origin !== location.origin) continue;
      const res = await fetch(url, { credentials: "same-origin", cache: "force-cache" });
      if (!res.ok) continue;
      const cues = parseCaptionPayload(await res.text());
      if (cues.length > 0) return { cues, language: u.searchParams.get("lang") ?? undefined, auto: u.searchParams.get("kind") === "asr" };
    } catch {
      // next
    }
  }
  return { cues: [] };
}

export type Acquired =
  | { status: "ok"; transcript: Transcript }
  /** The video has no captions / transcript. */
  | { status: "none" }
  /** Has (or may have) one, but reading it needs the panel opened and `allowOpen` was false, or it failed. */
  | { status: "unavailable" };

export async function acquireTranscript(doc: Document, video: VideoRef, opts: { allowOpen: boolean }): Promise<Acquired> {
  const tracks = inlineCaptionTracks(doc, video.videoId);
  const describe = (cues: Cue[], source: Transcript["source"], language?: string, auto?: boolean): Acquired => {
    const first = tracks?.[0];
    return {
      status: "ok",
      transcript: {
        videoId: video.videoId,
        cues,
        source,
        language: language ?? first?.languageCode,
        autoGenerated: auto ?? (tracks && tracks.length ? tracks.every((t) => t.kind === "asr") : looksUnpunctuated(cues)),
      },
    };
  };
  if (video.kind === "watch") {
    const open = readOpenPanel(doc);
    if (open.length > 0) return describe(open, "panel");
  }
  const cap = await readLoadedCaptions(video.videoId);
  if (cap.cues.length > 0) return describe(cap.cues, "captions", cap.language, cap.auto);
  if (tracks && tracks.length === 0) return { status: "none" };
  if (video.kind === "watch") {
    if (!transcriptButton(doc)) {
      return playerHasCaptions(doc) === false || tracks?.length === 0 ? { status: "none" } : { status: "unavailable" };
    }
    if (!opts.allowOpen) return { status: "unavailable" };
    const cues = await openPanelAndRead(doc);
    if (cues.length > 0) return describe(cues, "panel");
    return { status: "unavailable" };
  }
  // Shorts: no transcript panel; only a caption track the player loaded.
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
