// Hit-testing for sentence tooltips. The CSS Custom Highlight API renders
// highlights without creating any element to attach a hover/focus listener
// to, so instead we resolve the pointer position to a DOM caret and look up
// which ActiveSentence's Range contains it. (The <mark> fallback path could
// attach listeners directly, but reusing this single code path keeps
// behaviour identical between the two rendering strategies.)

import type { ActiveSentence } from "./types";

export interface HoverIndex {
  lookup(node: Node, offset: number): ActiveSentence | null;
}

function textNodesInRange(range: Range): Text[] {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) return [root as Text];
  const nodes: Text[] = [];
  try {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    let n = walker.nextNode();
    while (n) {
      nodes.push(n as Text);
      n = walker.nextNode();
    }
  } catch {
    // ignore
  }
  return nodes;
}

export function buildHoverIndex(sentences: ActiveSentence[]): HoverIndex {
  const map = new Map<Text, ActiveSentence[]>();
  for (const s of sentences) {
    try {
      for (const node of textNodesInRange(s.range)) {
        const list = map.get(node);
        if (list) list.push(s);
        else map.set(node, [s]);
      }
    } catch {
      // skip this sentence
    }
  }
  return {
    lookup(node, offset) {
      if (node.nodeType !== Node.TEXT_NODE) return null;
      const candidates = map.get(node as Text);
      if (!candidates) return null;
      for (const s of candidates) {
        try {
          if (s.range.comparePoint(node, offset) === 0) return s;
        } catch {
          // node/range in different trees, or range detached; skip
        }
      }
      return null;
    },
  };
}

interface CaretPositionLike {
  offsetNode: Node;
  offset: number;
}

/** Resolves a viewport point to a {node, offset}, across Chromium/Firefox/Safari. */
export function hitTestPoint(x: number, y: number): { node: Node; offset: number } | null {
  try {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => CaretPositionLike | null;
    };
    if (typeof doc.caretPositionFromPoint === "function") {
      const pos = doc.caretPositionFromPoint(x, y);
      if (pos) return { node: pos.offsetNode, offset: pos.offset };
      return null;
    }
    const docWithRange = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const range = docWithRange.caretRangeFromPoint?.(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  } catch {
    // ignore
  }
  return null;
}
