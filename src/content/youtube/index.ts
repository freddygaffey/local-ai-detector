// YouTube transcript check (docs/plan.md "Phase 2: T10"): follows the
// current video through YouTube's in-app navigation, reads its transcript
// (./acquire.ts), scores it through the engine's normal `analyze` path in
// timed blocks (./chunk.ts), maps the score with the transcript calibration
// (src/shared/transcript.ts) and shows it on the transcript chip (./ui.ts)
// and in the side panel (`getTranscriptReport`). Comments on the same page
// stay with the thread adapters; this never touches them.
//
// Automatic pass (same rules as the page chip: auto-run on, chip shown,
// battery allows): the fast model over whatever source is available,
// including opening the transcript panel -- invisibly, then closing it again
// (acquire.ts's openPanelAndRead already does this for a click, in about
// 0.8 s; there's no page-visible difference between the automatic and
// clicked paths, so the chip resolves to a result on its own instead of
// sitting on the bare "Transcript" placeholder until the user clicks it).

import { registerHandlers, sendMessage } from "../../shared/messages";
import { autoRunPolicyForSite, DEFAULT_SETTINGS, getSettings, setSettings, watchSettings, type Settings } from "../../shared/settings";
import { FLAGGED_THRESHOLD } from "../../shared/thresholds";
import { toTranscriptProbability, type TranscriptReport, type TranscriptSegment } from "../../shared/transcript";
import { fusionForTier } from "../../engine/models";
import { decidePowerAction, readBatteryState, readPressureState } from "../../power/battery";
import { acquireTranscript, isYouTubeHost, readDisclosure, videoFromUrl, type Acquired, type VideoRef } from "./acquire";
import { buildTranscriptBlocks, sampleBlocks, skipQuickPass, toTextBlocks, type TranscriptBlock } from "./chunk";
import { looksEnglish } from "./transcript";
import { createTranscriptChip, type TranscriptChipApi } from "./ui";
import { youTubeVideo } from "../../voice/content";

let settings: Settings = DEFAULT_SETTINGS;
let chip: TranscriptChipApi | null = null;
let video: VideoRef | null = null;
let report: TranscriptReport | null = null;
let runToken = 0;
/** Transcript source for a non-YouTube page (kind "page"), set by startPageTranscript. */
let pageAcquire: (() => Promise<Acquired>) | null = null;
/** The page router's gate (src/content/main.ts): false = this page type gets no transcript chip. */
let pageAllowed: () => boolean = () => true;

export function setTranscriptGate(fn: () => boolean): void {
  pageAllowed = fn;
  reconcileChip();
}

function emptyReport(v: VideoRef): TranscriptReport {
  return { videoId: v.videoId, state: "idle", segments: [], disclosure: null };
}

function publish(r: TranscriptReport | null): void {
  report = r;
  chip?.setReport(r);
}

function wantChip(): boolean {
  return settings.surfaces.chip && video !== null && pageAllowed();
}

function reconcileChip(): void {
  if (wantChip() && !chip) {
    chip = createTranscriptChip({
      onRun: () => void run("full", true),
      onSeek: seek,
      onConsent: () => {
        // Same global consent the popup's "Download & enable" sets; grant it
        // and retry with the full/Deep pass, now that everything's allowed.
        void setSettings({ consentedDownload: true }).then((s) => {
          settings = s;
          void run("full", true);
        });
      },
    });
    chip.setReport(report);
  } else if (!wantChip() && chip) {
    chip.destroy();
    chip = null;
  } else {
    chip?.remount();
  }
}

/** Seeks the current video (watch page player, or the active Short). */
export function seek(seconds: number): boolean {
  const v = youTubeVideo() ?? document.querySelector<HTMLVideoElement>("video");
  if (!v || !Number.isFinite(seconds)) return false;
  v.currentTime = Math.max(0, seconds);
  return true;
}

function snippet(text: string, words = 12): string {
  const w = text.trim().split(/\s+/);
  return w.length > words ? `${w.slice(0, words).join(" ")}…` : w.join(" ");
}

function disclosureNow(): string | null {
  try {
    return readDisclosure(document);
  } catch {
    return null;
  }
}

async function run(pass: "fast" | "full", allowOpen: boolean): Promise<void> {
  const v = video;
  if (!v) return;
  const token = ++runToken;
  const stale = () => token !== runToken || video?.videoId !== v.videoId;
  const base: TranscriptReport = { ...(report?.videoId === v.videoId ? report : emptyReport(v)), disclosure: disclosureNow() };
  publish({ ...base, state: "running" });
  try {
    const got = v.kind === "page" ? await (pageAcquire?.() ?? Promise.resolve<Acquired>({ status: "none" })) : await acquireTranscript(document, v);
    if (stale()) return;
    if (got.status === "none") return publish({ ...base, state: "none", segments: [] });
    if (got.status === "unavailable") return publish({ ...base, state: "error", error: "Couldn't read the transcript" });
    const t = got.transcript;
    const fullText = t.cues.map((c) => c.text).join(" ");
    if ((t.language && !/^en\b/i.test(t.language)) || !looksEnglish(fullText)) {
      return publish({ ...base, state: "not-english", language: t.language, source: t.source, segments: [] });
    }
    // Still resolve the chip to something other than the bare "Transcript"
    // placeholder (docs/plan.md "Two tiers" -- Quick must show a result by
    // default), so the user sees it tried and can click through to Deep.
    if (pass === "fast" && skipQuickPass(t.autoGenerated, t.cues)) {
      return publish({
        ...base,
        state: "error",
        source: t.source,
        autoGenerated: t.autoGenerated,
        language: t.language,
        error: "Auto-captions aren't punctuated; run the full check for a score",
      });
    }
    const all = buildTranscriptBlocks(t.cues, { idPrefix: `yt-${v.videoId}` });
    // Tiers task (docs/plan.md "Two tiers"): the automatic "fast" pass is
    // Quick (the cheapest detectors, a sampled budget); the clicked "full"
    // pass is Deep (every detector, the whole transcript).
    const tier: "quick" | "deep" = pass === "full" ? "deep" : "quick";
    const budget = pass === "full" ? settings.maxTokens : Math.max(300, Math.floor(settings.maxTokens * 0.7));
    const blocks = sampleBlocks(all, budget);
    const fusion = fusionForTier(tier, settings.tiers);
    const result = await sendMessage("analyze", {
      tabId: -1,
      mode: "ensemble",
      fusionOverride: fusion.detectors,
      tier,
      blocks: toTextBlocks(blocks),
    });
    if (stale()) return;
    const detectors = result.detectors?.map((d) => d.id);
    const method = result.fusion?.method;
    const byBlock = new Map<string, number[]>();
    for (const s of result.sentences) byBlock.set(s.blockId, [...(byBlock.get(s.blockId) ?? []), s.score]);
    const segments: TranscriptSegment[] = blocks
      .filter((b: TranscriptBlock) => byBlock.has(b.id))
      .map((b) => {
        const sc = byBlock.get(b.id)!;
        const score = sc.reduce((a, x) => a + x, 0) / sc.length;
        return { start: b.start, end: b.end, score, probability: toTranscriptProbability(score, { detectors, method, words: b.words }), words: b.words, snippet: snippet(b.text) };
      });
    publish({
      ...base,
      state: "done",
      pass,
      tier,
      overall: result.overall,
      probability: toTranscriptProbability(result.overall, { detectors, method, words: result.words }),
      source: t.source,
      autoGenerated: t.autoGenerated,
      language: t.language,
      analysedWords: result.words,
      totalWords: all.reduce((n, b) => n + b.words, 0),
      duration: all.length ? all[all.length - 1]!.end : undefined,
      segments,
      disclosure: disclosureNow() ?? base.disclosure,
    });
  } catch (err) {
    if (stale()) return;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("consent-required")) {
      // The background already worked out the real, cache-aware download
      // size ("...about NN MB, once)..."); reuse it instead of guessing here.
      const mb = msg.match(/about (\d+) MB/)?.[1];
      return publish({ ...base, state: "consent", consentMB: mb ? Number(mb) : undefined });
    }
    publish({ ...base, state: "error", error: msg });
  }
}

async function maybeAutoRun(): Promise<void> {
  if (!video || !settings.surfaces.chip || !pageAllowed()) return;
  // Tiers task (docs/plan.md "Two tiers"): "Run quick check automatically"
  // off means no automatic pass here either -- the Deep ("full") pass still
  // runs on click, from the chip or `runDeepTranscriptCheck`.
  if (!settings.tiers.autoRunQuick) return;
  if (autoRunPolicyForSite(settings, location.hostname) !== "always") return;
  try {
    const [battery, pressure] = await Promise.all([readBatteryState(), readPressureState()]);
    if (decidePowerAction(battery, pressure, settings.battery).pauseAutoRun) return;
  } catch {
    // no battery info: go ahead
  }
  // allowOpen: true -- opening the transcript panel is already invisible
  // (acquire.ts hides it with a style rule and restores scroll/focus), so the
  // automatic pass gets it too instead of only the clicked Deep pass.
  await run("fast", true);
}

/**
 * Deep check (docs/plan.md "Two tiers"): triggered from the page-level ↻
 * (popup/pill/side panel) so a Deep run also gets the whole transcript on a
 * YouTube video page. A no-op with no video on this page (including every
 * non-YouTube page, since `video` never gets set there).
 */
export async function runDeepTranscriptCheck(): Promise<void> {
  if (!video || report?.state === "running") return;
  await run("full", true);
}

let navTimer: ReturnType<typeof setTimeout> | undefined;

function onLocationMaybeChanged(): void {
  const next = videoFromUrl(location.href);
  if (next?.videoId === video?.videoId && next?.kind === video?.kind) {
    reconcileChip();
    return;
  }
  video = next;
  runToken++;
  publish(next ? emptyReport(next) : null);
  reconcileChip();
  clearTimeout(navTimer);
  // Give YouTube a moment to render the new video's description and player.
  if (next) navTimer = setTimeout(() => void maybeAutoRun(), 2500);
}

let registered = false;
function registerOnce(): void {
  if (registered) return;
  registered = true;
  watchSettings((s) => {
    settings = s;
    reconcileChip();
  });
  registerHandlers({
    getTranscriptReport: async (req) => {
      if (req?.run && video && report?.state !== "running") await run("full", true);
      if (report && report.state !== "running") report = { ...report, disclosure: disclosureNow() ?? report.disclosure };
      return report;
    },
    seekVideo: ({ seconds }) => (seek(seconds) ? { ok: true } : { ok: false, error: "No video on this page" }),
  });
}

/** Entry point (src/content/main.ts). A no-op off youtube.com. */
export function startYouTubeTranscripts(): void {
  try {
    if (!isYouTubeHost(location.hostname)) return;
  } catch {
    return;
  }
  void getSettings()
    .catch(() => DEFAULT_SETTINGS)
    .then((s) => {
      settings = s;
      onLocationMaybeChanged();
    });
  registerOnce();
  // YouTube is a single-page app: it fires this on every in-app navigation.
  document.addEventListener("yt-navigate-finish", () => onLocationMaybeChanged());
  window.addEventListener("popstate", () => onLocationMaybeChanged());
  // Fallback for navigations that don't fire the event (and to re-attach the chip if YouTube re-rendered its title).
  setInterval(() => onLocationMaybeChanged(), 1500);
}

/**
 * A transcript on a non-YouTube page (src/content/pageMedia.ts): a page
 * video's <track> captions, or a subtitle file / transcript page itself.
 * Same chip, scoring and Quick/Deep passes as YouTube; the chip sits in a
 * fixed corner.
 */
export async function startPageTranscript(id: string, acquire: () => Promise<Acquired>): Promise<void> {
  settings = await getSettings().catch(() => DEFAULT_SETTINGS);
  registerOnce();
  pageAcquire = acquire;
  if (video?.kind === "page" && video.videoId === id) return reconcileChip();
  video = { videoId: id, kind: "page" };
  runToken++;
  publish(emptyReport(video));
  reconcileChip();
  await maybeAutoRun();
}

export function stopPageTranscript(): void {
  if (video?.kind !== "page") return;
  video = null;
  pageAcquire = null;
  runToken++;
  publish(null);
  reconcileChip();
}

/** Flagged segments (engine score at or above the flag point), for tests and the side panel. */
export function flaggedSegments(r: TranscriptReport | null): TranscriptSegment[] {
  return r?.state === "done" ? r.segments.filter((s) => s.score >= FLAGGED_THRESHOLD) : [];
}
