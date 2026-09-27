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

function insertOne(block: BlockRecord, charIndex: number, finding: UnicodeFinding, scan: UnicodeScanResult): HTMLElement | null {
  const seg = findSegment(block.segments, charIndex);
  if (!seg || !seg.node.isConnected) return null;
  const node = seg.node;
  const localOffset = seg.nodeOffset + (charIndex - seg.start) + 1; // right after the flagged char
  const marker = document.createElement("span");
  marker.className = "ai-detector-unicode-marker";
  marker.textContent = `⟦${LABELS[finding.category]}⟧`;
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
  const occurrences: { index: number; finding: UnicodeFinding }[] = [];
  for (const finding of scan.findings) {
    for (const index of finding.indices) occurrences.push({ index, finding });
  }
  occurrences.sort((a, b) => b.index - a.index);

  const markers: HTMLElement[] = [];
  for (const { index, finding } of occurrences) {
    try {
      const marker = insertOne(block, index, finding, scan);
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
