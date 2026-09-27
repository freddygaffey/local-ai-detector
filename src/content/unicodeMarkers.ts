// Hidden/unusual Unicode markers: small visible inline markers (e.g.
// "⟦ZW⟧") inserted right after each flagged character, with a tooltip
// naming the character and any decoded hidden message. Labelled neutrally
// as "unusual characters" -- never as evidence of AI (see docs/plan.md §3).
//
// Runs scanUnicode() locally per block (rather than relying on the engine's
// aggregate AnalyzeResult.unicode, whose offsets are relative to however T1
// concatenates blocks) so marker placement uses exactly the same block
// offsets as our own DOM mapping. See the final report for this
// coordination note.

import { scanUnicode, type UnicodeFinding, type UnicodeScanResult } from "../detectors/unicode";
import { formatUnicodeTooltip, hideTooltip, showTooltip } from "./tooltip";
import type { BlockRecord, NodeSegment } from "./types";

const LABELS: Record<UnicodeFinding["category"], string> = {
  "zero-width": "ZW",
  "bidi-control": "BIDI",
  "unusual-space": "SP",
  "soft-hyphen": "SH",
  "tag-character": "TAG",
  "variation-selector": "VS",
};

interface PlacedMarker {
  el: HTMLElement;
}

let activeMarkers: PlacedMarker[] = [];

function findSegment(segments: NodeSegment[], at: number): NodeSegment | null {
  for (const seg of segments) {
    if (at >= seg.start && at < seg.end) return seg;
  }
  return null;
}

/**
 * Inserts one marker right after `end` (exclusive offset into block.text,
 * i.e. just past the last flagged code unit of a run), so astral characters
 * (tag characters, VS supplement) are never split between their surrogates.
 */
function insertOne(block: BlockRecord, end: number, count: number, finding: UnicodeFinding, scan: UnicodeScanResult): HTMLElement | null {
  const seg = findSegment(block.segments, end - 1);
  if (!seg || !seg.node.isConnected) return null;
  const node = seg.node;
  const localOffset = seg.nodeOffset + (end - seg.start);
  const marker = document.createElement("span");
  marker.className = "ai-detector-unicode-marker";
  marker.textContent = `⟦${LABELS[finding.category]}${count > 1 ? `×${count}` : ""}⟧`;
  marker.tabIndex = 0;
  marker.setAttribute("role", "note");
  const { title, lines } = formatUnicodeTooltip(finding, scan.hiddenMessage);
  marker.setAttribute("aria-label", `${title}. ${lines.join(" ")}`);
  marker.style.cssText =
    "all: revert; display: inline; font-size: 0.75em; opacity: 0.75; padding: 0 1px; border-radius: 2px; " +
    "background: rgba(128,128,128,0.25); cursor: help; vertical-align: super; line-height: 1;";

  const show = () => showTooltip(marker.getBoundingClientRect(), title, lines);
  marker.addEventListener("mouseenter", show);
  marker.addEventListener("focus", show);
  marker.addEventListener("mouseleave", hideTooltip);
  marker.addEventListener("blur", hideTooltip);

  try {
    if (!node.parentNode) return null;
    if (localOffset >= node.data.length) {
      node.parentNode.insertBefore(marker, node.nextSibling);
    } else if (localOffset <= 0) {
      node.parentNode.insertBefore(marker, node);
    } else {
      const after = node.splitText(localOffset);
      node.parentNode.insertBefore(marker, after);
    }
    return marker;
  } catch {
    return null;
  }
}

/**
 * Scans `block.text` and inserts a marker after every flagged character.
 * Processes occurrences in descending offset order so each DOM split only
 * ever truncates the tail of a Text node -- earlier (smaller-offset)
 * lookups against the same original segment stay valid.
 */
export function renderUnicodeMarkers(block: BlockRecord): { scan: UnicodeScanResult; markers: HTMLElement[] } {
  const scan = scanUnicode(block.text);
  const runs = groupRuns(scan.findings);
  // Descending offset order: each DOM split only ever truncates the tail of
  // a Text node, so earlier (smaller-offset) segment lookups stay valid.
  runs.sort((a, b) => b.end - a.end);

  const markers: HTMLElement[] = [];
  for (const run of runs) {
    try {
      const marker = insertOne(block, run.end, run.count, run.finding, scan);
      if (marker) {
        markers.push(marker);
        activeMarkers.push({ el: marker });
      }
    } catch {
      // Never let one bad marker break the rest of the page.
    }
  }
  return { scan, markers };
}

export interface MarkerRun {
  finding: UnicodeFinding;
  start: number;
  /** Exclusive end (UTF-16 offset). */
  end: number;
  count: number;
}

/**
 * Groups adjacent flagged characters of the same category into one run
 * (e.g. a 40-character tag-character message becomes one "⟦TAG×40⟧" marker
 * instead of 40), with UTF-16-correct ends for astral characters.
 */
export function groupRuns(findings: UnicodeFinding[]): MarkerRun[] {
  const occ: { index: number; len: number; finding: UnicodeFinding }[] = [];
  for (const finding of findings) {
    const len = finding.codePoint > 0xffff ? 2 : 1;
    for (const index of finding.indices) occ.push({ index, len, finding });
  }
  occ.sort((a, b) => a.index - b.index);
  const runs: MarkerRun[] = [];
  for (const o of occ) {
    const last = runs[runs.length - 1];
    if (last && last.end === o.index && last.finding.category === o.finding.category) {
      last.end = o.index + o.len;
      last.count++;
    } else {
      runs.push({ finding: o.finding, start: o.index, end: o.index + o.len, count: 1 });
    }
  }
  return runs;
}

export function clearUnicodeMarkers(): void {
  for (const { el } of activeMarkers) {
    try {
      el.remove();
    } catch {
      // ignore
    }
  }
  activeMarkers = [];
}
