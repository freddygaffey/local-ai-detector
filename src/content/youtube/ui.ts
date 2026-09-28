// The transcript chip on a YouTube video (docs/plan.md "Phase 2: T10";
// "Display rules"): one small inline label under the video title --
// "Transcript: AI 84%", "Transcript: —", "No transcript" -- with YouTube's
// own disclosure ("YouTube: Made with AI") as a separate label beside it.
// Clicking runs the full check, then toggles Details: flagged segments with
// timestamps (click one to seek the video) and one line of technical detail.
// Closed shadow DOM, so page CSS can't leak in or out.

import { formatTimestamp } from "./transcript";
import type { TranscriptReport } from "../../shared/transcript";
import { FLAGGED_THRESHOLD } from "../../shared/thresholds";
import { scoreColor } from "../colors";

export interface TranscriptChipCallbacks {
  onRun(): void;
  onSeek(seconds: number): void;
  /** Model download not consented to yet ("consent" state): grants it and retries. */
  onConsent(): void;
}

export interface TranscriptChipApi {
  setReport(report: TranscriptReport | null): void;
  /** Re-attaches under the current video's title if YouTube re-rendered it away. */
  remount(): void;
  destroy(): void;
}

function theme(): "light" | "dark" {
  try {
    if (document.documentElement.hasAttribute("dark")) return "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

const CSS = `
  :host { all: initial; display: inline-block; vertical-align: top; margin-right: 6px; }
  * { box-sizing: border-box; }
  .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 6px 0 2px;
    font: 12px/1.3 Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .fixed .row { margin: 0; }
  button { font: inherit; cursor: pointer; }
  .chip { font-weight: 600; border-radius: 999px; padding: 3px 10px; border: 1px solid var(--line);
    background: var(--bg); color: var(--fg); }
  .chip.muted { color: var(--muted); font-weight: 500; }
  .chip:hover, .chip:focus-visible { border-color: var(--fg); outline: none; }
  .action { font: inherit; font-weight: 600; cursor: pointer; border-radius: 999px; padding: 4px 12px;
    border: 1px solid var(--link); background: var(--bg); color: var(--link); }
  .action:hover, .action:focus-visible { background: var(--link); color: var(--bg); outline: none; }
  .label { border-radius: 999px; padding: 3px 10px; background: var(--warnbg); color: var(--warnfg); font-weight: 600; }
  .details { margin-top: 6px; max-width: 560px; border: 1px solid var(--line); border-radius: 10px; padding: 8px;
    background: var(--bg); color: var(--fg); font: 12px/1.4 Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .details[hidden] { display: none; }
  ul { list-style: none; margin: 0; padding: 0; max-height: 220px; overflow: auto; }
  li button { display: grid; grid-template-columns: auto auto 1fr; gap: 8px; width: 100%; text-align: left;
    background: none; border: 0; color: inherit; padding: 4px 6px; border-radius: 6px; }
  li button:hover, li button:focus-visible { background: var(--hover); outline: none; }
  .ts { font-variant-numeric: tabular-nums; color: var(--link); font-weight: 600; }
  .pct { font-variant-numeric: tabular-nums; font-weight: 600; }
  .snip { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { margin-top: 6px; color: var(--muted); font-size: 11px; }
  .empty { color: var(--muted); padding: 2px 6px; }
  :host { --bg: #fff; --fg: #0f0f0f; --muted: #606060; --line: rgba(0,0,0,0.15); --hover: rgba(0,0,0,0.06);
    --link: #065fd4; --warnbg: #fff3cd; --warnfg: #5c4400; }
  :host(.dark) { --bg: #212121; --fg: #f1f1f1; --muted: #aaa; --line: rgba(255,255,255,0.2); --hover: rgba(255,255,255,0.08);
    --link: #3ea6ff; --warnbg: #4a3b00; --warnfg: #ffe08a; }
`;

const TITLE_SELECTORS = [
  "ytd-watch-metadata #title",
  "#above-the-fold #title",
  "ytd-reel-video-renderer[is-active] yt-shorts-video-title-view-model",
  "yt-shorts-video-title-view-model",
];

/**
 * The on-screen video title (watch page or the Short in view). YouTube keeps
 * the watch page's DOM around, hidden, while Shorts play, so only a title
 * that is actually laid out and in the viewport counts. Shared with the voice chip.
 */
export function visibleVideoTitle(doc: Document = document): Element | null {
  for (const sel of TITLE_SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll(sel))) {
      const r = el.getClientRects()[0];
      if (r && r.bottom > 0 && r.top < innerHeight && r.width > 0) return el;
    }
  }
  return null;
}

/** A YouTube Short: the corner card alone summarises it; inline chips would sit on the video. */
export function onShorts(): boolean {
  return location.hostname.endsWith("youtube.com") && /^\/shorts(\/|$)/.test(location.pathname);
}

/** Where the chip goes: under the video title; null = a fixed corner (unknown layouts, other sites). */
function anchor(): Element | null {
  return visibleVideoTitle();
}

export function chipLabel(r: TranscriptReport | null): { text: string; muted: boolean; score?: number } {
  if (!r || r.state === "idle") return { text: "Transcript", muted: true };
  switch (r.state) {
    case "running":
      return { text: "Transcript…", muted: true };
    case "none":
      return { text: "No transcript", muted: true };
    case "not-english":
      return { text: "Transcript: English only", muted: true };
    case "consent":
      return { text: "Transcript: download models", muted: true };
    case "error":
      return { text: "Transcript: —", muted: true };
    case "done":
      if (r.probability === undefined) return { text: "Transcript: —", muted: true };
      return { text: `Transcript: AI ${Math.round(r.probability * 100)}%`, muted: false, score: r.probability };
  }
}

export function detailsMeta(r: TranscriptReport): string {
  const parts: string[] = [];
  parts.push(r.source === "captions" || r.source === "track" ? "Caption track" : r.source === "text" ? "Subtitle text" : "Transcript panel");
  if (r.autoGenerated) parts.push("auto-captions");
  if (r.analysedWords !== undefined && r.totalWords !== undefined && r.analysedWords < r.totalWords) {
    parts.push(`${r.analysedWords} of ${r.totalWords} words analysed`);
  } else if (r.totalWords !== undefined) {
    parts.push(`${r.totalWords} words`);
  }
  parts.push(r.pass === "full" ? "full check" : "quick check");
  parts.push(r.source === "text" ? "probability, not proof" : "probability, not proof; detects AI-written scripts, not AI voices");
  return parts.join(" · ");
}

export function createTranscriptChip(cb: TranscriptChipCallbacks): TranscriptChipApi {
  const host = document.createElement("ai-detector-transcript");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = CSS;
  const wrap = document.createElement("div");
  const row = document.createElement("div");
  row.className = "row";
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip muted";
  const label = document.createElement("span");
  label.className = "label";
  label.hidden = true;
  const details = document.createElement("div");
  details.className = "details";
  details.hidden = true;
  row.append(chip, label);
  wrap.append(row, details);
  shadow.append(style, wrap);

  let report: TranscriptReport | null = null;

  const place = () => {
    host.classList.toggle("dark", theme() === "dark");
    if (onShorts()) {
      host.style.cssText = "display:none !important;";
      return;
    }
    const a = anchor();
    if (a) {
      host.style.cssText = "visibility:visible !important;";
      wrap.className = "";
      if (a.nextElementSibling !== host) a.after(host);
    } else {
      host.style.cssText = "position:fixed; left:12px; bottom:12px; z-index:2147482000; visibility:visible !important;";
      wrap.className = "fixed";
      if (host.parentElement !== document.body) document.body.appendChild(host);
    }
  };

  const renderDetails = () => {
    details.replaceChildren();
    if (report?.state === "consent") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "action";
      btn.textContent = report.consentMB !== undefined ? `Download models (${report.consentMB} MB)` : "Download models";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        cb.onConsent();
      });
      const note = document.createElement("div");
      note.className = "meta";
      note.textContent = "Needed once, on-device; nothing leaves your device.";
      details.append(btn, note);
      details.hidden = false;
      return;
    }
    if (!report || report.state !== "done") {
      details.hidden = true;
      return;
    }
    const flagged = report.segments.filter((s) => s.score >= FLAGGED_THRESHOLD);
    if (flagged.length === 0) {
      const p = document.createElement("div");
      p.className = "empty";
      p.textContent = "Nothing flagged.";
      details.append(p);
    } else {
      const ul = document.createElement("ul");
      for (const s of flagged) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.title = `Jump to ${formatTimestamp(s.start)}`;
        const ts = document.createElement("span");
        ts.className = "ts";
        ts.textContent = formatTimestamp(s.start);
        const pct = document.createElement("span");
        pct.className = "pct";
        pct.textContent = s.probability !== undefined ? `AI ${Math.round(s.probability * 100)}%` : "—";
        const snip = document.createElement("span");
        snip.className = "snip";
        snip.textContent = s.snippet;
        b.append(ts, pct, snip);
        b.addEventListener("click", () => cb.onSeek(s.start));
        li.append(b);
        ul.append(li);
      }
      details.append(ul);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = detailsMeta(report);
    details.append(meta);
  };

  const render = () => {
    const l = chipLabel(report);
    chip.textContent = l.text;
    chip.classList.toggle("muted", l.muted);
    chip.style.color = l.score !== undefined ? scoreColor(l.score, theme()) : "";
    chip.setAttribute(
      "aria-label",
      report?.state === "done"
        ? `${l.text}. Show flagged segments.`
        : report?.state === "running"
          ? "Checking the transcript"
          : report?.state === "consent"
            ? `${l.text}. Model download needs your consent.`
            : `${l.text}. Check the transcript for AI writing.`,
    );
    chip.disabled = report?.state === "running";
    label.hidden = !report?.disclosure;
    label.textContent = report?.disclosure ? `YouTube: ${report.disclosure}` : "";
    renderDetails();
  };

  chip.addEventListener("click", () => {
    if (!report) return cb.onRun();
    if (report.state === "idle" || report.state === "error") return cb.onRun();
    if (report.state === "done") {
      if (report.pass !== "full") {
        details.hidden = false;
        return cb.onRun();
      }
      details.hidden = !details.hidden;
    }
  });

  place();
  render();

  return {
    setReport(r) {
      const videoChanged = r?.videoId !== report?.videoId;
      report = r;
      if (videoChanged) details.hidden = true;
      render();
    },
    remount() {
      place();
    },
    destroy() {
      host.remove();
    },
  };
}
