// Content-script side of the voice check (T11). Standalone: one call,
// startVoiceContent(), from src/content/main.ts.
//
// - YouTube watch/Shorts: follows in-app navigation (yt-navigate-finish,
//   popstate, a 1.5 s poll: same signals as T10's transcript check), shows
//   the voice chip beside the transcript chip, and (Run: "Auto on YouTube")
//   starts sampling the current video. Ads are skipped. A new video stops
//   the old session and starts fresh.
// - Any site: right-click a <video> -> "Check voice (experimental)" starts a
//   session on that video with a fixed-corner chip.
// Pause/seek handling and all sampling rules live in ./capture.ts.

import { browser } from "wxt/browser";
import { DEFAULT_SETTINGS, getSettings, isPaused, setSettings, watchSettings, type Settings } from "../shared/settings";
import { decidePowerAction, readBatteryState, readPressureState } from "../power/battery";
import { publishVoiceStatus, voiceRateOk } from "../content/videoStatus";
import { sourceAudioReady, sourceClip, startSourceAudio } from "./sourceAudio";
import { VoiceSession, type VoiceState } from "./capture";
import { createVoiceChip, type VoiceChipApi } from "./ui";
import { isVoiceProgress, VOICE_START_KIND, type VoiceRequest, type VoiceResponse } from "./protocol";
import { sanitizeVoice } from "./settings";
import { resolveVoiceRate } from "./rate";

let settings: Settings = DEFAULT_SETTINGS;
let session: VoiceSession | null = null;
let chip: VoiceChipApi | null = null;
let chipFixed = false;
let ytVideoId: string | null = null;
let lastContextVideo: HTMLVideoElement | null = null;
// Quick/Deep tier (docs/plan.md "Two tiers"): automatic runs are Quick (Light rate);
// the Deep check button switches the current video to Deep (Thorough) until the next video.
let voiceTier: "quick" | "deep" = "quick";
const rate = () => resolveVoiceRate({ ...settings, tier: voiceTier } as never);

const voice = () => sanitizeVoice(settings.voice);
/** The page router's gate (src/content/main.ts): false = no voice chip on this page type. */
let pageAllowed: () => boolean = () => true;

export function setVoiceGate(fn: () => boolean): void {
  pageAllowed = fn;
  if (!fn()) {
    stopSession();
    chip?.destroy();
    chip = null;
    ytVideoId = null;
  }
}

/**
 * A non-YouTube video page (src/content/pageMedia.ts): a quiet "Voice" chip
 * in the corner; it samples the video automatically under "Auto on any
 * video" (the default), otherwise when clicked.
 */
export function offerVoiceOnClick(video: HTMLVideoElement): void {
  if (!voice().enabled || !settings.surfaces.chip || !pageAllowed()) return;
  lastContextVideo = video;
  if (session?.video === video) return;
  ensureChip(true).setState(null, { settings: voice(), rate: rate() });
  // "Auto on any video": sample it like a YouTube video (only while it plays).
  if (voice().run === "autoAll" && !isPaused(settings)) void startSession(video, true);
}

export function withdrawVoiceOffer(): void {
  if (!chipFixed) return;
  stopSession();
  chip?.destroy();
  chip = null;
}

/** Video id whose automatic voice check is still waiting for its player. */
let autoPending: string | null = null;

/** YouTube video id + kind from a URL (watch or Shorts), else null. */
export function youTubeVideoId(href: string): string | null {
  try {
    const u = new URL(href);
    if (!/(^|\.)youtube\.com$/.test(u.hostname) || /^(music|studio|tv)\./.test(u.hostname)) return null;
    if (u.pathname === "/watch") return u.searchParams.get("v");
    return u.pathname.match(/^\/shorts\/([\w-]{6,})/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The playing YouTube video: the Short in view (#shorts-player) or the watch player -- whichever is laid out. */
export function youTubeVideo(doc: Document = document): HTMLVideoElement | null {
  const shorts = location.pathname.startsWith("/shorts/");
  const sels = shorts
    ? ["#shorts-player video", "ytd-reel-video-renderer[is-active] video", "#movie_player video.html5-main-video"]
    : ["#movie_player video.html5-main-video", "#shorts-player video"];
  for (const sel of sels) {
    for (const v of Array.from(doc.querySelectorAll<HTMLVideoElement>(sel))) if (v.getClientRects().length) return v;
  }
  return null;
}

function adShowing(): boolean {
  return !!document.querySelector("#movie_player.ad-showing, #movie_player.ad-interrupting");
}

let lastState: VoiceState | null = null;
function render(state: VoiceState | null): void {
  lastState = state;
  chip?.setState(state, { settings: voice(), rate: rate() });
  // Original audio from the tap: speed doesn't matter, so don't report it.
  const speed = sourceAudioReady() ? undefined : session?.video.playbackRate;
  publishVoiceStatus(
    state || session ? { p: state?.agg.p ?? null, clips: state?.agg.clips ?? 0, speed } : null,
  );
}

function ensureChip(fixedOnly: boolean): VoiceChipApi {
  if (chip && chipFixed !== fixedOnly) {
    chip.destroy();
    chip = null;
  }
  chipFixed = fixedOnly;
  chip ??= createVoiceChip(
    {
      onRun: () => {
        const v = fixedOnly ? lastContextVideo : youTubeVideo();
        if (v) void startSession(v, fixedOnly);
      },
      onDeep: () => runDeepVoiceCheck(),
      onSeek: (t) => {
        if (session && Number.isFinite(t)) session.video.currentTime = Math.max(0, t);
      },
      onConsent: () => {
        // Same global consent the popup's "Download & enable" sets; grant it
        // and retry the session so the chip moves straight to downloading.
        void setSettings({ consentedDownload: true }).then((s) => {
          settings = s;
          const v = fixedOnly ? lastContextVideo : youTubeVideo();
          if (v) void startSession(v, fixedOnly);
        });
      },
    },
    { fixedOnly },
  );
  return chip;
}

function stopSession(): void {
  session?.stop();
  session = null;
  publishVoiceStatus(null);
}

async function startSession(video: HTMLVideoElement, fixedOnly: boolean): Promise<void> {
  if (!voice().enabled) return;
  stopSession();
  const onYouTube = /(^|\.)youtube\.com$/.test(location.hostname) && video === youTubeVideo();
  const c = ensureChip(fixedOnly);
  const power = decidePowerAction(await readBatteryState(), await readPressureState(), settings.battery);
  const v = voice();
  const s = new VoiceSession(video, {
    rate: rate(),
    batterySaver: power.reason !== null,
    model: v.model,
    sensitivity: v.sensitivity,
    // Skip ads. On YouTube, clips come from the original downloaded audio
    // (any speed); recording what plays is the fallback, and only at speeds
    // the detector handles (voiceRateOk: past 2x the browser's time-stretch
    // reads as synthetic).
    skip: () => !fixedOnly && adShowing(),
    source: onYouTube ? (atS) => sourceClip(atS) : undefined,
    canRecord: () => voiceRateOk(video.playbackRate),
    score: (pcmB64) =>
      browser.runtime.sendMessage({ kind: "lad-voice", op: "score", model: v.model, pcmB64 } satisfies VoiceRequest) as Promise<VoiceResponse>,
    onUpdate: (st) => {
      if (session === s) render(st);
    },
  });
  session = s;
  c.setState(null, { settings: v, rate: rate() });
  // Voice pauses away from 1x; re-publish on speed changes so the card can say why.
  video.addEventListener("ratechange", () => {
    if (session === s) render(lastState);
  });
  s.start();
  render(null);
}

async function onYouTubeLocation(): Promise<void> {
  const id = youTubeVideoId(location.href);
  const wantChip = id !== null && voice().enabled && settings.surfaces.chip && pageAllowed();
  if (id === ytVideoId) {
    if (wantChip) ensureChip(false).remount();
    // The player wasn't ready within the first wait (e.g. landing on
    // /shorts, which redirects to a Short that loads late): start as soon
    // as it is, on a later tick.
    if (wantChip && !session && autoPending === id) void retryAutoStart(id);
    return;
  }
  ytVideoId = id;
  voiceTier = "quick";
  stopSession();
  if (!wantChip) {
    chip?.destroy();
    chip = null;
    // Not "seen" yet: the page router can allow this video a moment later
    // (on /shorts it first routes the landing page, then the Short), and it
    // must then count as a new video so the automatic check starts.
    ytVideoId = null;
    return;
  }
  ensureChip(false).setState(null, { settings: voice(), rate: rate() });
  if (voice().run === "onClick" || isPaused(settings)) return;
  // Pending until it starts: a later tick retries (a momentary CPU-pressure
  // spike while the page loads, or a player that loads late, used to cancel
  // the automatic check for the whole video).
  autoPending = id;
  const power = decidePowerAction(await readBatteryState(), await readPressureState(), settings.battery);
  if (power.pauseAutoRun && power.reason !== "cpu-pressure") autoPending = null;
  if (power.pauseAutoRun) return;
  // Wait for YouTube to swap in the new video's player.
  for (let i = 0; i < 20 && ytVideoId === id; i++) {
    const v = youTubeVideo();
    if (v && v.readyState > 0) {
      autoPending = null;
      return void startSession(v, false);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

let retrying = false;
async function retryAutoStart(id: string): Promise<void> {
  if (retrying) return;
  retrying = true;
  try {
    const power = decidePowerAction(await readBatteryState(), await readPressureState(), settings.battery);
    if (power.pauseAutoRun || ytVideoId !== id || session) return;
    const v = youTubeVideo();
    if (v && v.readyState > 0) {
      autoPending = null;
      await startSession(v, false);
    }
  } finally {
    retrying = false;
  }
}

/** Deep check: restart voice sampling on the current video at the Thorough rate. */
export function runDeepVoiceCheck(): void {
  voiceTier = "deep";
  const video = session?.video ?? (youTubeVideoId(location.href) !== null ? youTubeVideo() : lastContextVideo);
  if (video) void startSession(video, session ? chipFixed : youTubeVideoId(location.href) === null);
}

export function startVoiceContent(): void {
  void getSettings()
    .catch(() => DEFAULT_SETTINGS)
    .then((s) => {
      settings = s;
      if (youTubeVideoId(location.href) !== null || /(^|\.)youtube\.com$/.test(location.hostname)) {
        startSourceAudio();
        void onYouTubeLocation();
        document.addEventListener("yt-navigate-finish", () => void onYouTubeLocation());
        window.addEventListener("popstate", () => void onYouTubeLocation());
        setInterval(() => void onYouTubeLocation(), 1500);
      }
    });
  watchSettings((s) => {
    const before = voice();
    settings = s;
    const after = voice();
    if (!after.enabled) {
      stopSession();
      chip?.destroy();
      chip = null;
      ytVideoId = null; // re-evaluate if turned back on
    } else if (before.model !== after.model || before.sensitivity !== after.sensitivity) {
      // Scores from another model/operating point don't mix: start over.
      if (session) void startSession(session.video, chipFixed);
    }
  });
  // "Auto on any video": any <video> that starts playing with sound, on any
  // site (YouTube has its own path above). One session at a time; a video
  // that starts later takes over only if the current one isn't playing.
  const autoAny = (e: Event) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || v.paused || v.muted || voice().run !== "autoAll" || isPaused(settings)) return;
    if (/(^|\.)youtube\.com$/.test(location.hostname) || !pageAllowed()) return;
    if (session?.video === v || (session && !session.video.paused)) return;
    if (v.getBoundingClientRect().width < 160) return; // previews, ads, background loops
    lastContextVideo = v;
    void startSession(v, true);
  };
  // "playing" for autoplay, "volumechange" for a muted autoplay the user unmutes.
  document.addEventListener("playing", autoAny, { capture: true });
  document.addEventListener("volumechange", autoAny, { capture: true });
  document.addEventListener(
    "contextmenu",
    (e) => {
      const t = e.target as Element | null;
      lastContextVideo = t instanceof HTMLVideoElement ? t : (t?.closest?.("video") as HTMLVideoElement | null) ?? lastContextVideo;
    },
    { capture: true },
  );
  browser.runtime.onMessage.addListener((msg: unknown) => {
    if (isVoiceProgress(msg)) {
      session?.onDownload(msg.loaded, msg.total);
      return undefined;
    }
    const m = msg as { kind?: string; srcUrl?: string };
    if (m?.kind !== VOICE_START_KIND) return undefined;
    const v =
      lastContextVideo ??
      [...document.querySelectorAll("video")].find((x) => m.srcUrl && (x.currentSrc === m.srcUrl || x.src === m.srcUrl)) ??
      null;
    if (v) void startSession(v, !(youTubeVideoId(location.href) !== null && v === youTubeVideo()));
    return undefined;
  });
}
