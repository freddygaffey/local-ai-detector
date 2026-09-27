// Shared floating tooltip (Shadow DOM, closed, no page CSS leakage) used for
// both sentence-score tooltips (hover/focus of a highlighted sentence) and
// hidden-Unicode marker tooltips. A singleton: showTooltip()/hideTooltip()
// are cheap to call from hover/focus handlers in hover.ts and
// unicodeMarkers.ts.

import type { ScoreSource } from "../shared/messages";
import { riskLevel } from "./colors";
import type { ActiveSentence } from "./types";
import type { UnicodeFinding } from "../detectors/unicode";

const HOST_ID = "ai-detector-tooltip-host";

let host: HTMLElement | null = null;
let bubble: HTMLDivElement | null = null;

function css(): string {
  return `
    :host { all: initial; }
    .bubble {
      position: fixed;
      max-width: 320px;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #1f2430;
      color: #f2f2f2;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 8px;
      padding: 8px 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.35);
      z-index: 2147483647;
      pointer-events: none;
    }
    @media (prefers-color-scheme: light) {
      .bubble { background: #ffffff; color: #1a1a1a; border-color: rgba(0,0,0,0.12); box-shadow: 0 4px 16px rgba(0,0,0,0.18); }
    }
    .title { font-weight: 600; margin-bottom: 4px; }
    .line { opacity: 0.9; margin-top: 2px; }
    .line.note { opacity: 0.7; font-style: italic; margin-top: 6px; }
    @media (prefers-reduced-motion: no-preference) {
      .bubble { transition: opacity 120ms ease, transform 120ms ease; }
    }
  `;
}

function ensure(): void {
  if (host) return;
  host = document.createElement("ai-detector-tooltip-host");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed; left:0; top:0; z-index:2147483647; pointer-events:none;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = css();
  bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.setAttribute("role", "tooltip");
  bubble.hidden = true;
  shadow.append(style, bubble);
  (document.body ?? document.documentElement).appendChild(host);
}

function positionNear(rect: DOMRect): void {
  if (!bubble) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bw = Math.min(320, bubble.offsetWidth || 280);
  const bh = bubble.offsetHeight || 60;
  let left = rect.left;
  let top = rect.top - bh - 8;
  if (top < 4) top = rect.bottom + 8;
  if (top + bh > vh - 4) top = Math.max(4, vh - bh - 4);
  if (left + bw > vw - 4) left = Math.max(4, vw - bw - 4);
  if (left < 4) left = 4;
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
}

export function showTooltip(rect: DOMRect, title: string, lines: string[]): void {
  try {
    ensure();
    if (!bubble) return;
    bubble.replaceChildren();
    const h = document.createElement("div");
    h.className = "title";
    h.textContent = title;
    bubble.appendChild(h);
    for (const line of lines) {
      const p = document.createElement("div");
      p.className = "line";
      p.textContent = line;
      bubble.appendChild(p);
    }
    bubble.hidden = false;
    positionNear(rect);
  } catch {
    // Never break the host page over a tooltip.
  }
}

export function hideTooltip(): void {
  try {
    if (bubble) bubble.hidden = true;
  } catch {
    // ignore
  }
}

export function destroyTooltip(): void {
  try {
    host?.remove();
  } catch {
    // ignore
  } finally {
    host = null;
    bubble = null;
  }
}

const SOURCE_LABELS: Record<ScoreSource, string> = {
  classifier: "Classifier",
  perplexity: "Perplexity",
  binoculars: "Binoculars",
};

/** Score %, per-detector breakdown and a confidence note for a sentence. */
export function formatSentenceTooltip(s: ActiveSentence): { title: string; lines: string[] } {
  const pct = Math.round((s.probability ?? s.score) * 100);
  const level = riskLevel(s.score);
  const title = `AI likelihood: ${pct}% (${level} confidence signal)`;
  const lines: string[] = [];
  const order: ScoreSource[] = ["classifier", "perplexity", "binoculars"];
  for (const key of order) {
    const v = s.sources[key];
    if (v !== undefined) lines.push(`${SOURCE_LABELS[key]}: ${Math.round(v * 100)}%`);
  }
  if (s.muted) {
    lines.push("This sentence is short, so its score is unreliable.");
  }
  lines.push("Probability, not proof. Short and non-English text score less reliably.");
  return { title, lines };
}

/** Char name and, for tag-character findings, any decoded hidden message. */
export function formatUnicodeTooltip(
  finding: UnicodeFinding,
  hiddenMessage: string | null,
): { title: string; lines: string[] } {
  const title = `Unusual character: ${finding.hex} ${finding.name}`;
  const lines: string[] = [
    "Flags unusual or hidden characters -- not evidence of AI. Many uses are legitimate.",
  ];
  if (hiddenMessage && finding.category === "tag-character") {
    lines.push(`Decoded hidden text nearby: "${hiddenMessage}"`);
  }
  return { title, lines };
}
