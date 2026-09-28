// Corner card (docs/plan.md "Primary UI: the corner card"): the pure part.
// Turns what the content script knows about the page (its type, the latest
// text result, the video checks, image provenance, hidden characters) into
// the card's three layers:
//   collapsed  a thumbnail-sized stacked summary ("AI 12%", "3 AI",
//              "Script 23%" / "Voice 1%") plus a marker row, coloured by the
//              worst signal;
//   hover      every essential line, compact (verdict per signal, page type
//              and why, detector agreement, Quick vs Deep, the device);
//   panel      the supplementary details (per-detector numbers etc.) are
//              built by ./card.ts from the same state.
// No DOM here, so every page type's summary is unit-tested (cardSummary.test.ts).

import type { PageType } from "./pageType";
import type { Agreement, ImageProvenanceSummary } from "../shared/messages";
import type { Tier } from "../shared/settings";
import { BAND_LABEL, type Band } from "../ui/verdict";
import type { VideoStatus } from "./videoStatus";

export interface CardMeta {
  tier?: Tier;
  /** The Quick pass scored high and the default Fusion re-checked it. */
  confirmed?: boolean;
  agreement?: Agreement;
  device?: string;
  /** Per-detector raw scores (0..1), in run order. */
  detectors?: { label: string; overall: number; device?: string }[];
  words?: number;
}

export interface CardState {
  pageType: PageType;
  /** Short "why" from the classifier ("YouTube", "JSON-LD Article"). */
  pageReason?: string;
  /** "Page type: off" for this site: nothing on the page, the card included. */
  off?: boolean;
  /** An analysis is in flight; `progress` is 0..1 when known. */
  running?: boolean;
  progress?: number;
  error?: string;
  /** Article: the page's calibrated P(AI); null = too short ("—"). */
  article?: {
    probability: number | null;
    flagged: number;
    sentences: number;
    /** `bandFromResult()`: the same one-word verdict the popup shows. */
    band?: Band;
  };
  /** Thread/comments: items at or over the filter threshold, of the scored items. */
  thread?: { flagged: number; total: number; maxProbability?: number };
  /** Search results: snippets marked, of the snippets scored. */
  search?: { flagged: number; total: number; maxProbability?: number };
  video?: VideoStatus;
  images?: ImageProvenanceSummary;
  hidden?: { count: number; message: boolean };
  meta?: CardMeta;
}

export interface SummaryLine {
  text: string;
  /** The score behind this line, for its colour (none = neutral ink). */
  score?: number;
}

export interface Marker {
  /** Two-letter glyph shown on the card. */
  code: "CR" | "WM" | "AI" | "U+" | "YT";
  /** Spoken / hover wording. */
  label: string;
}

export interface CollapsedSummary {
  /** Nothing to draw at all (a page-type "off" override). */
  hidden: boolean;
  /** App / unsupported page: a dim glyph that still opens the panel. */
  idle: boolean;
  lines: SummaryLine[];
  /** Worst score across every signal shown: the card's accent colour and weight. */
  worst?: number;
  markers: Marker[];
  running: boolean;
  ariaLabel: string;
}

export interface HoverLine {
  label: string;
  value: string;
  score?: number;
  /** A quieter, secondary row (page type, device). */
  dim?: boolean;
}

const pct = (p: number) => `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;

function max(xs: (number | undefined | null)[]): number | undefined {
  const nums = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return nums.length ? Math.max(...nums) : undefined;
}

/** Image provenance + hidden characters + a platform AI label: the marker row, only what's present. */
export function markers(s: CardState): Marker[] {
  const out: Marker[] = [];
  const img = s.images;
  if (img && !img.disabled) {
    if (img.withCredentials > 0) out.push({ code: "CR", label: `Content Credentials on ${img.withCredentials} image${img.withCredentials === 1 ? "" : "s"}` });
    if (img.withWatermark > 0) out.push({ code: "WM", label: `AI watermark in ${img.withWatermark} image${img.withWatermark === 1 ? "" : "s"}` });
    if (img.withUnsignedClaim > 0) out.push({ code: "AI", label: `AI claim in ${img.withUnsignedClaim} image${img.withUnsignedClaim === 1 ? "" : "s"}' metadata` });
  }
  if (s.hidden && s.hidden.count > 0) out.push({ code: "U+", label: `${s.hidden.count} hidden character${s.hidden.count === 1 ? "" : "s"}${s.hidden.message ? ", hidden message" : ""}` });
  if (s.video?.disclosure) out.push({ code: "YT", label: `Platform label: ${s.video.disclosure}` });
  return out;
}

function videoLines(v: VideoStatus | undefined, running: boolean): SummaryLine[] {
  const lines: SummaryLine[] = [];
  if (typeof v?.transcript === "number") lines.push({ text: `Script ${pct(v.transcript)}`, score: v.transcript });
  else if (v?.transcriptState === "none") lines.push({ text: "Script —" });
  else if (v?.transcriptState && v.transcriptState !== "idle") lines.push({ text: "Script …" });
  if (typeof v?.voice === "number") lines.push({ text: `Voice ${pct(v.voice)}`, score: v.voice });
  else if (v?.voice === null) lines.push({ text: "Voice …" });
  if (!lines.length) lines.push({ text: running ? "Script …" : "Script —" });
  return lines;
}

/** The collapsed card: at most two short lines, one per signal that matters on this page type. */
export function collapsedSummary(s: CardState): CollapsedSummary {
  const marks = markers(s);
  const running = !!s.running;
  if (s.off) return { hidden: true, idle: true, lines: [], markers: [], running: false, ariaLabel: "" };

  let lines: SummaryLine[] = [];
  let idle = false;
  // No result yet: an ellipsis while checking, a bare "AI" (press to check) otherwise.
  const pending = running ? "AI …" : "AI";
  switch (s.pageType) {
    case "article":
    case "thread": {
      // Comments found (a thread, or an article with a comment section): the
      // count of AI items; otherwise the page's single %.
      const t = s.thread;
      const a = s.article;
      if (t) lines = [{ text: `${t.flagged} AI`, score: t.maxProbability }, { text: `of ${t.total}` }];
      else if (a) lines = [{ text: a.probability === null ? "AI —" : `AI ${pct(a.probability)}`, score: a.probability ?? undefined }];
      else lines = [{ text: pending }];
      break;
    }
    case "video":
    case "subtitles":
      lines = videoLines(s.video, running);
      break;
    case "search": {
      const r = s.search;
      if (r) lines = [{ text: `${r.flagged} AI`, score: r.maxProbability }, { text: `of ${r.total}` }];
      else lines = [{ text: pending }];
      break;
    }
    default:
      // App pages: nothing runs automatically; a dim glyph that still opens the panel.
      idle = !s.article && !s.thread;
      if (s.article) lines = [{ text: s.article.probability === null ? "AI —" : `AI ${pct(s.article.probability)}`, score: s.article.probability ?? undefined }];
      break;
  }
  if (s.error && !lines.some((l) => l.score !== undefined)) lines = [{ text: "AI ✕" }];

  const worst = max(lines.map((l) => l.score));
  const spoken = idle ? "AI detector: nothing checked on this page" : `AI detection: ${lines.map((l) => l.text).join(" ")}`;
  const extra = marks.length ? `. ${marks.map((m) => m.label).join(", ")}` : "";
  return {
    hidden: false,
    idle,
    lines,
    worst,
    markers: marks,
    running,
    ariaLabel: `${spoken}${running ? ", checking" : ""}${extra}. Press for details.`,
  };
}

const TYPE_NAME: Record<PageType, string> = {
  article: "Article",
  thread: "Thread",
  video: "Video",
  subtitles: "Subtitles",
  search: "Search",
  app: "App",
};

/** The hover card: every essential line, one fact each. */
export function hoverLines(s: CardState): HoverLine[] {
  const out: HoverLine[] = [];
  if (s.article) {
    const a = s.article;
    out.push({
      label: "Text",
      value: a.probability === null ? `— ${BAND_LABEL.insufficient}` : `${pct(a.probability)}${a.band ? ` ${BAND_LABEL[a.band]}` : ""}`,
      score: a.probability ?? undefined,
    });
    if (a.sentences > 0) out.push({ label: "Sentences", value: `${a.flagged}/${a.sentences} flagged`, dim: true });
  }
  if (s.thread) out.push({ label: "Comments", value: `${s.thread.flagged}/${s.thread.total} AI`, score: s.thread.maxProbability });
  if (s.search) out.push({ label: "Snippets", value: `${s.search.flagged}/${s.search.total} AI`, score: s.search.maxProbability });
  if (s.pageType === "video" || s.pageType === "subtitles" || s.video?.transcriptState) {
    const v = s.video ?? {};
    if (typeof v.transcript === "number") out.push({ label: "Script", value: pct(v.transcript), score: v.transcript });
    else out.push({ label: "Script", value: transcriptStateText(v.transcriptState) });
    if (s.pageType === "video") {
      if (typeof v.voice === "number") out.push({ label: "Voice", value: pct(v.voice), score: v.voice });
      else if (v.voice === null) out.push({ label: "Voice", value: `sampling${v.voiceClips ? ` (${v.voiceClips} clips)` : ""}` });
      else out.push({ label: "Voice", value: "not checked" });
    }
  }
  for (const m of markers(s)) out.push({ label: markerTitle(m.code), value: m.label.replace(/^.*?: /, "") });
  if (s.error) out.push({ label: "Error", value: s.error });
  if (s.running) out.push({ label: "Status", value: s.progress !== undefined ? `checking ${pct(s.progress)}` : "checking…" });

  const m = s.meta;
  if (m?.agreement) out.push({ label: "Detectors", value: `${m.agreement.agree}/${m.agreement.total} agree${m.agreement.disagree ? ", split" : ""}` });
  else if (m?.detectors?.length) out.push({ label: "Detectors", value: m.detectors.map((d) => d.label).join(", ") });
  if (m?.tier || m?.device) {
    const tier = m.tier === "deep" ? "Deep" : m.tier === "quick" ? (m.confirmed ? "Quick, confirmed" : "Quick") : undefined;
    out.push({ label: "Check", value: [tier, deviceName(m.device)].filter(Boolean).join(" on "), dim: true });
  }
  out.push({ label: "Page", value: `${TYPE_NAME[s.pageType]}${s.pageReason ? ` (${s.pageReason})` : ""}`, dim: true });
  return out;
}

function markerTitle(code: Marker["code"]): string {
  switch (code) {
    case "CR":
      return "Credentials";
    case "WM":
      return "Watermark";
    case "AI":
      return "AI claim";
    case "U+":
      return "Hidden";
    case "YT":
      return "Label";
  }
}

function transcriptStateText(state: string | undefined): string {
  switch (state) {
    case "running":
      return "checking…";
    case "none":
      return "no captions";
    case "not-english":
      return "not English";
    case "consent":
      return "needs model download";
    case "error":
      return "couldn't read";
    default:
      return "not checked";
  }
}

export function deviceName(d: string | undefined): string | undefined {
  switch (d) {
    case "webgpu":
      return "WebGPU";
    case "wasm":
    case "cpu":
      return "CPU";
    case "mixed":
      return "WebGPU + CPU";
    default:
      return undefined;
  }
}
