// YouTube captions, read in the page's own (MAIN) world, where the player's
// API lives (entrypoints/youtube-main.content.ts runs this at
// document_start on youtube.com; the isolated content script asks for a
// video's captions over window.postMessage, see ./acquire.ts).
//
// Why here: since 2025 YouTube's /api/timedtext answers an empty 200 unless
// the request carries the player's proof-of-origin token (`pot`). The track
// list's bare baseUrl, and the transcript panel opened hidden (it never
// loads while display:none), both come back empty in a real browser. What
// does work is the player's own caption request:
//
//  1. If the player already fetched a caption track for this video (the
//     user has CC on, or an earlier check), re-read that URL, switched to
//     the wanted language, as json3.
//  2. Otherwise switch the chosen track on through the player API with the
//     caption window hidden, catch the request it makes, and switch it back
//     off (restoring YouTube's saved caption preferences exactly as they
//     were), then re-read that URL.
//
// Everything stays on youtube.com; nothing new leaves the device.

export const CAPTIONS_REQUEST = "lad-yt-captions-request";
export const CAPTIONS_RESPONSE = "lad-yt-captions-response";

export interface CaptionsRequest {
  source: typeof CAPTIONS_REQUEST;
  id: string;
  videoId: string;
}

export type CaptionsResult =
  | { status: "ok"; body: string; language: string; auto: boolean }
  /** The video has no caption tracks at all. */
  | { status: "none" }
  | { status: "error"; error: string };

export type CaptionsResponse = { source: typeof CAPTIONS_RESPONSE; id: string } & CaptionsResult;

interface Track {
  languageCode: string;
  kind?: string;
  baseUrl?: string;
  vssId?: string;
}

interface YtPlayer extends HTMLElement {
  getVideoData?(): { video_id?: string };
  getPlayerResponse?(): {
    videoDetails?: { videoId?: string };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Track[] } };
  } | null;
  getOption?(module: string, option: string): unknown;
  setOption?(module: string, option: string, value: unknown): void;
  loadModule?(module: string): void;
  unloadModule?(module: string): void;
}

/** Picks the track to score: English (uploaded) > English (auto) > any uploaded > first. Pure. */
export function pickTrack(tracks: readonly Track[]): Track | null {
  const en = (t: Track) => /^en\b/i.test(t.languageCode);
  const asr = (t: Track) => t.kind === "asr";
  return tracks.find((t) => en(t) && !asr(t)) ?? tracks.find(en) ?? tracks.find((t) => !asr(t)) ?? tracks[0] ?? null;
}

/**
 * The player's own caption URL re-pointed at `track`, as json3. Pure.
 * Edits the query string in place rather than re-serialising it: the URL is
 * signed, and URLSearchParams would re-encode values (sparams' commas ->
 * %2C), which makes YouTube answer with an empty body.
 */
export function trackUrl(playerUrl: string, track: Track): string {
  const [base, hash = ""] = playerUrl.split("#");
  let url = base!;
  const setParam = (name: string, value: string | null) => {
    const re = new RegExp(`([?&])${name}=[^&]*`);
    if (value === null) {
      url = url.replace(new RegExp(`[?&]${name}=[^&]*`), (m) => (m.startsWith("?") ? "?" : "")).replace("?&", "?");
    } else if (re.test(url)) {
      url = url.replace(re, `$1${name}=${encodeURIComponent(value)}`);
    } else {
      url += `${url.includes("?") ? "&" : "?"}${name}=${encodeURIComponent(value)}`;
    }
  };
  setParam("lang", track.languageCode);
  setParam("kind", track.kind === "asr" ? "asr" : null);
  setParam("tlang", null);
  setParam("fmt", "json3");
  return hash ? `${url}#${hash}` : url;
}

/** A /api/timedtext URL the player made (it carries `pot`) for this video. Pure. */
export function isPlayerCaptionUrl(url: string, videoId: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname === "/api/timedtext" && u.searchParams.get("v") === videoId && u.searchParams.has("pot");
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts the page-world responder. Call once, at document_start. */
export function startPageCaptions(): void {
  const seen: string[] = [];
  const record = (name: string) => {
    if (name.includes("/api/timedtext") && name.includes("pot=")) {
      seen.push(name);
      if (seen.length > 50) seen.shift();
    }
  };
  // An observer, not performance.getEntries(): YouTube fills the 250-entry
  // resource-timing buffer within minutes, after which nothing new is listed.
  try {
    new PerformanceObserver((list) => list.getEntries().forEach((e) => record(e.name))).observe({ type: "resource", buffered: true });
  } catch {
    // very old engine: getEntries() below still covers the first requests
  }
  const playerUrlFor = (videoId: string): string | null => {
    for (let i = seen.length - 1; i >= 0; i--) if (isPlayerCaptionUrl(seen[i]!, videoId)) return seen[i]!;
    for (const e of performance.getEntriesByType("resource").reverse()) if (isPlayerCaptionUrl(e.name, videoId)) return e.name;
    return null;
  };

  const findPlayer = (videoId: string): YtPlayer | null => {
    const cands = [
      document.querySelector("#shorts-player"),
      document.querySelector("#movie_player"),
      ...Array.from(document.querySelectorAll(".html5-video-player")),
    ] as (YtPlayer | null)[];
    for (const p of cands) {
      try {
        if (p?.getVideoData?.()?.video_id === videoId && p.getPlayerResponse?.()?.videoDetails?.videoId === videoId) return p;
      } catch {
        // next
      }
    }
    return null;
  };

  const fetchBody = async (url: string): Promise<string> => {
    const res = await fetch(url, { credentials: "same-origin" });
    return res.ok ? await res.text() : "";
  };

  /** Switches `track` on (hidden) until the player has requested it, then restores everything. */
  const captureViaPlayer = async (p: YtPlayer, videoId: string, track: Track): Promise<string | null> => {
    const saved: [string, string][] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /^yt-player-caption/.test(k)) saved.push([k, localStorage.getItem(k) ?? ""]);
    }
    const prev = (() => {
      try {
        return p.getOption?.("captions", "track") as Track | undefined;
      } catch {
        return undefined;
      }
    })();
    const style = document.createElement("style");
    style.textContent = ".ytp-caption-window-container,.caption-window{visibility:hidden!important}";
    (document.head ?? document.documentElement).appendChild(style);
    try {
      p.loadModule?.("captions");
      p.setOption?.("captions", "track", track.kind === "asr" ? { languageCode: track.languageCode, kind: "asr" } : { languageCode: track.languageCode });
      for (let t = 0; t < 40; t++) {
        await sleep(200);
        const url = playerUrlFor(videoId);
        if (url) return url;
      }
      return null;
    } finally {
      try {
        if (prev?.languageCode) p.setOption?.("captions", "track", prev);
        else p.unloadModule?.("captions");
      } catch {
        // ignore
      }
      // Our switch mustn't become the user's saved caption preference.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && /^yt-player-caption/.test(k) && !saved.some(([sk]) => sk === k)) localStorage.removeItem(k);
      }
      for (const [k, v] of saved) localStorage.setItem(k, v);
      setTimeout(() => style.remove(), 600);
    }
  };

  const getCaptions = async (videoId: string): Promise<CaptionsResult> => {
    let p: YtPlayer | null = null;
    for (let t = 0; t < 25 && !p; t++) {
      p = findPlayer(videoId);
      if (!p) await sleep(200);
    }
    if (!p) return { status: "error", error: "player not ready" };
    const tracks = p.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const track = pickTrack(tracks);
    if (!track) return { status: "none" };
    const done = async (url: string): Promise<CaptionsResult | null> => {
      const body = await fetchBody(trackUrl(url, track)).catch(() => "");
      return body.trim() ? { status: "ok", body, language: track.languageCode, auto: track.kind === "asr" } : null;
    };
    const existing = playerUrlFor(videoId);
    if (existing) {
      const r = await done(existing);
      if (r) return r;
    }
    const captured = await captureViaPlayer(p, videoId, track);
    if (captured) {
      const r = await done(captured);
      if (r) return r;
    }
    return { status: "error", error: "captions didn't load" };
  };

  let queue: Promise<unknown> = Promise.resolve();
  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as Partial<CaptionsRequest> | null;
    if (!d || d.source !== CAPTIONS_REQUEST || typeof d.id !== "string" || typeof d.videoId !== "string") return;
    const { id, videoId } = d;
    // One at a time: two concurrent switches would fight over the player.
    queue = queue.then(async () => {
      const res = await getCaptions(videoId).catch((err: unknown): CaptionsResult => ({ status: "error", error: String(err) }));
      window.postMessage({ source: CAPTIONS_RESPONSE, id, ...res } satisfies CaptionsResponse, location.origin);
    });
  });
}
