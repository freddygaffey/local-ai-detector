// "Analyze selection" support: builds a single BlockRecord from the current
// window selection instead of walking the whole page. Triggered from the
// popup (T3) or a context-menu item (background) via the `runAnalysis`
// message with `{ selectionOnly: true }` (see messaging.ts).

import { appendCollapsedRun } from "./extract";
import { segmentSentences } from "./segment";
import type { BlockRecord, NodeSegment } from "./types";

let selBlockCounter = 0;

/**
 * Returns a BlockRecord built from `window.getSelection()`'s first range, or
 * null if there is no non-collapsed text selection. Only the first range is
 * supported (multi-range selection, e.g. table column selection in Firefox,
 * is a known gap -- see final report).
 */
export function extractSelectionBlock(win: Window = window): BlockRecord | null {
  try {
    const sel = win.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return null;
    const owner = closestElement(range.commonAncestorContainer);
    if (!owner) return null;

    const acc: { text: string; segments: NodeSegment[] } = { text: "", segments: [] };
    const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
      if (range.intersectsNode(node)) {
        const localStart = node === range.startContainer ? range.startOffset : 0;
        const localEnd = node === range.endContainer ? range.endOffset : node.data.length;
        if (localEnd > localStart) {
          appendCollapsedRun(acc, node, localStart, node.data.slice(localStart, localEnd));
        }
      }
      node = walker.nextNode() as Text | null;
    }
    if (acc.text.trim().length === 0) return null;
    const sentences = segmentSentences(acc.text);
    if (sentences.length === 0) return null;

    selBlockCounter += 1;
    return {
      id: `sel-${Date.now()}-${selBlockCounter}`,
      text: acc.text,
      sentences,
      segments: acc.segments,
      owner,
    };
  } catch {
    return null;
  }
}

function closestElement(node: Node): Element | null {
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  return node.parentElement;
}
