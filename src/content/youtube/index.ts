// YouTube transcript check (docs/plan.md "Phase 2: T10"): follows the
// current video through YouTube's in-app navigation, reads its transcript
// (./acquire.ts), scores it through the engine's normal `analyze` path in
// timed blocks (./chunk.ts), maps the score with the transcript calibration
// (src/shared/transcript.ts) and shows it on the transcript chip (./ui.ts)
// and in the side panel (`getTranscriptReport`). Comments on the same page
// stay with the thread adapters; this never touches them.
//
// Automatic pass (same rules as the page chip: auto-run on, chip shown,
// battery allows): only side-effect-free sources, i.e. a transcript panel
// that's already open or a caption track the player already loaded, scored
// with the fast model. Anything that needs the panel opened waits for a click.

import { registerHandlers, sendMessage } from "../../shared/messages";
import { autoRunPolicyForSite, DEFAULT_SETTINGS, getSettings, watchSettings, type Settings } from "../../shared/settings";
import { FLAGGED_THRESHOLD } from "../../shared/thresholds";
import { toTranscriptProbability, type TranscriptReport, type TranscriptSegment } from "../../shared/transcript";
import { decidePowerAction, readBatteryState, readPressureState } from "../../power/battery";
import { acquireTranscript, isYouTubeHost, readDisclosure, videoFromUrl, type VideoRef } from "./acquire";
import { buildTranscriptBlocks, sampleBlocks, toTextBlocks, type TranscriptBlock } from "./chunk";
import { looksEnglish } from "./transcript";
import { createTranscriptChip, type TranscriptChipApi } from "./ui";

let settings: Settings = DEFAULT_SETTINGS;
let chip: TranscriptChipApi | null = null;
let video: VideoRef | null = null;
let report: TranscriptReport | null = null;
let runToken = 0;

function emptyReport(v: VideoRef): TranscriptReport {
  return { videoId: v.videoId, state: "idle", segments: [], disclosure: null };
}

function publish(r: TranscriptReport | null): void {
  report = r;
  chip?.setReport(r);
}

function wantChip(): boolean {
  return settings.surfaces.chip && video !== null;
}

function reconcileChip(): void {
  if (wantChip() && !chip) {
    chip = createTranscriptChip({ onRun: () => void run("full", true), onSeek: seek });
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
  const v =
    document.querySelector<HTMLVideoElement>("ytd-reel-video-renderer[is-active] video") ??
    document.querySelector<HTMLVideoElement>("#movie_player video.html5-main-video") ??
    document.querySelector<HTMLVideoElement>("video");
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
    const got = await acquireTranscript(document, v, { allowOpen });
    if (stale()) return;
    if (got.status === "none") return publish({ ...base, state: "none", segments: [] });
    if (got.status === "unavailable") return publish({ ...base, state: allowOpen ? "error" : "idle", error: allowOpen ? "Couldn't read the transcript" : undefined });
    const t = got.transcript;
    const fullText = t.cues.map((c) => c.text).join(" ");
    if ((t.language && !/^en\b/i.test(t.language)) || !looksEnglish(fullText)) {
      return publish({ ...base, state: "not-english", language: t.language, source: t.source, segments: [] });
    }
    const all = buildTranscriptBlocks(t.cues, { idPrefix: `yt-${v.videoId}` });
    const budget = Math.max(300, Math.floor(settings.maxTokens * 0.7));
    const blocks = sampleBlocks(all, budget);
    const mode = pass === "full" ? settings.mode : settings.autoRunFastMode;
    const result = await sendMessage("analyze", { tabId: -1, mode, blocks: toTextBlocks(blocks) });
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
    publish({ ...base, state: "error", error: msg.replace(/^consent-required:\s*/, "Download models first: ") });
  }
}

async function maybeAutoRun(): Promise<void> {
  if (!video || !settings.surfaces.chip) return;
  if (autoRunPolicyForSite(settings, location.hostname) !== "always") return;
  try {
    const [battery, pressure] = await Promise.all([readBatteryState(), readPressureState()]);
    if (decidePowerAction(battery, pressure, settings.battery).pauseAutoRun) return;
  } catch {
    // no battery info: go ahead
  }
  await run("fast", false);
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
  // YouTube is a single-page app: it fires this on every in-app navigation.
  document.addEventListener("yt-navigate-finish", () => onLocationMaybeChanged());
  window.addEventListener("popstate", () => onLocationMaybeChanged());
  // Fallback for navigations that don't fire the event (and to re-attach the chip if YouTube re-rendered its title).
  setInterval(() => onLocationMaybeChanged(), 1500);
}

/** Flagged segments (engine score at or above the flag point), for tests and the side panel. */
export function flaggedSegments(r: TranscriptReport | null): TranscriptSegment[] {
  return r?.state === "done" ? r.segments.filter((s) => s.score >= FLAGGED_THRESHOLD) : [];
}
