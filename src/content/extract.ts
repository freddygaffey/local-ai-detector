// Visible-text extraction: walks the DOM for readable content, groups it
// into TextBlocks (skipping nav/footer/aside/script/style/hidden/aria-hidden/
// contenteditable UI chrome, entering accessible open shadow roots), and
// keeps a mapping from sentence offsets back to DOM Text-node ranges so
// highlights land exactly.
//
// Kept import-light (only src/shared/messages.ts + segment.ts) but is
// inherently DOM-dependent, so it is exercised indirectly (via the demo page
// and manual QA) rather than by unit tests -- see the test-gap note in the
// final report.

import type { TextBlock } from "../shared/messages";
import { segmentSentences } from "./segment";
import type { BlockRecord, NodeSegment } from "./types";

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "NAV",
  "FOOTER",
  "ASIDE",
  "SVG",
  "IFRAME",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "BUTTON",
  "OPTION",
  "CANVAS",
  "VIDEO",
  "AUDIO",
  "MATH",
  "AI-DETECTOR-PILL",
  "AI-DETECTOR-TOOLTIP",
]);

// Nearest matching ancestor becomes a text node's "block owner" -- nesting
// order doesn't matter since we always stop at the closest match.
const BLOCK_TAGS = new Set([
  "P",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "PRE",
  "TD",
  "TH",
  "DT",
  "DD",
  "FIGCAPTION",
  "CAPTION",
  "SUMMARY",
  "ARTICLE",
  "SECTION",
  "DIV",
  "TR",
  "UL",
  "OL",
]);

function isContentEditableAncestor(el: Element): boolean {
  let cur: Element | null = el;
  while (cur) {
    const v = cur.getAttribute?.("contenteditable");
    if (v !== null && v !== undefined && v !== "false") return true;
    cur = cur.parentElement;
  }
  return false;
}

function isHiddenElement(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true;
  const aria = el.getAttribute("aria-hidden");
  if (aria === "true") return true;
  if (el instanceof HTMLElement && el.hidden) return true;
  try {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return true;
    }
  } catch {
    // getComputedStyle can throw on detached/foreign nodes; treat as visible.
  }
  return false;
}

function shouldSkipSubtree(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (isHiddenElement(el)) return true;
  if (isContentEditableAncestor(el)) return true;
  return false;
}

interface MutableBlock {
  owner: Element;
  text: string;
  segments: NodeSegment[];
}

interface WalkState {
  byOwner: Map<Element, MutableBlock>;
  order: MutableBlock[];
  root: Element;
}

function closestBlockOwner(textParent: Element, root: Element): Element {
  let el: Element | null = textParent;
  while (el && el !== root) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return root;
}

function isFormattingWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/**
 * Appends `piece` (a substring of `node.data` starting at `pieceStart`) to a
 * block's accumulated text, collapsing runs of formatting whitespace
 * (space/tab/newline/CR/form-feed -- NOT non-breaking space or other Unicode
 * spaces, which are real content) to a single space, the way a browser's
 * `white-space: normal` rendering does. Real HTML source is indented and
 * newline-separated, and feeding that raw whitespace straight into
 * Intl.Segmenter produces bogus sentence breaks -- this keeps extracted text
 * (and therefore sentence offsets) matching what's actually visible.
 *
 * Exported so selection.ts can build its block the same way.
 */
export function appendCollapsedRun(
  block: { text: string; segments: NodeSegment[] },
  node: Text,
  pieceStart: number,
  piece: string,
): void {
  let i = 0;
  while (i < piece.length) {
    const isWs = isFormattingWhitespace(piece[i]!);
    let j = i + 1;
    while (j < piece.length && isFormattingWhitespace(piece[j]!) === isWs) j++;
    if (isWs) {
      // Collapse the whole run to a single space, skipped entirely if the
      // block already ends with one (mimics collapsing across node/element
      // boundaries too, e.g. "<b>foo</b> <i>bar</i>").
      if (block.text.length > 0 && !block.text.endsWith(" ")) {
        const start = block.text.length;
        block.text += " ";
        block.segments.push({ node, nodeOffset: pieceStart + i, start, end: start + 1 });
      }
    } else {
      const start = block.text.length;
      const chunk = piece.slice(i, j);
      block.text += chunk;
      block.segments.push({ node, nodeOffset: pieceStart + i, start, end: start + chunk.length });
    }
    i = j;
  }
}

function walk(node: Node, state: WalkState): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node as Text).data;
    if (text.length === 0) return;
    const parent = (node as Text).parentElement;
    if (!parent) return;
    const owner = closestBlockOwner(parent, state.root);
    let block = state.byOwner.get(owner);
    if (!block) {
      block = { owner, text: "", segments: [] };
      state.byOwner.set(owner, block);
      state.order.push(block);
    }
    appendCollapsedRun(block, node as Text, 0, text);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  try {
    if (shouldSkipSubtree(el)) return;
  } catch {
    return;
  }
  const shadow = (el as HTMLElement).shadowRoot ?? null;
  if (shadow) {
    // Render what the shadow root actually shows; skip light-DOM children to
    // avoid double-counting slotted fallback content (a documented
    // simplification -- see final report).
    for (const child of Array.from(shadow.childNodes)) walk(child, state);
    return;
  }
  for (const child of Array.from(el.childNodes)) walk(child, state);
}

function pickRoot(doc: Document): Element {
  const main = doc.querySelector("main");
  if (main) return main;
  let bestArticle: Element | null = null;
  let bestLen = 0;
  for (const article of doc.querySelectorAll("article")) {
    const len = (article.textContent ?? "").length;
    if (len > bestLen) {
      bestLen = len;
      bestArticle = article;
    }
  }
  if (bestArticle && bestLen > 200) return bestArticle;
  return doc.body ?? doc.documentElement;
}

let blockCounter = 0;
function nextBlockId(): string {
  blockCounter += 1;
  return `blk-${Date.now()}-${blockCounter}`;
}

function finalizeBlock(mutable: MutableBlock): BlockRecord | null {
  if (mutable.text.trim().length === 0) return null;
  const sentences = segmentSentences(mutable.text);
  if (sentences.length === 0) return null;
  return {
    id: nextBlockId(),
    text: mutable.text,
    sentences,
    segments: mutable.segments,
    owner: mutable.owner,
  };
}

/**
 * Walks the page (or a supplied root, mainly for tests/tools) for visible,
 * readable text and returns it grouped into blocks with sentence offsets and
 * a DOM mapping. Never throws -- returns [] on any unexpected failure.
 */
export function extractVisibleBlocks(doc: Document = document): BlockRecord[] {
  try {
    const root = pickRoot(doc);
    const state: WalkState = { byOwner: new Map(), order: [], root };
    walk(root, state);
    const records: BlockRecord[] = [];
    for (const mutable of state.order) {
      const rec = finalizeBlock(mutable);
      if (rec) records.push(rec);
    }
    return records;
  } catch {
    return [];
  }
}

/** Strips DOM references for the wire format sent to the background/engine. */
export function toWireBlocks(records: BlockRecord[]): TextBlock[] {
  return records.map((r) => ({ id: r.id, text: r.text, sentences: r.sentences }));
}

/**
 * Resolves a [start, end) character span (within `block.text`) to a live DOM
 * Range, using the block's segment mapping. Returns null if the span is
 * empty/out of bounds or the backing nodes are no longer connected.
 */
export function getRangeForOffsets(block: BlockRecord, start: number, end: number): Range | null {
  if (end <= start || block.segments.length === 0) return null;
  const startSeg = findSegment(block.segments, start, false);
  const endSeg = findSegment(block.segments, end, true);
  if (!startSeg || !endSeg) return null;
  if (!startSeg.node.isConnected || !endSeg.node.isConnected) return null;
  try {
    const range = document.createRange();
    range.setStart(startSeg.node, startSeg.nodeOffset + (start - startSeg.start));
    range.setEnd(endSeg.node, endSeg.nodeOffset + (end - endSeg.start));
    return range;
  } catch {
    return null;
  }
}

/**
 * Finds the segment containing offset `at`. When `isEnd` is true, `at` is an
 * exclusive end offset, so a segment boundary match prefers the segment that
 * *ends* there rather than the following one.
 */
function findSegment(segments: NodeSegment[], at: number, isEnd: boolean): NodeSegment | null {
  for (const seg of segments) {
    if (isEnd) {
      if (at > seg.start && at <= seg.end) return seg;
    } else {
      if (at >= seg.start && at < seg.end) return seg;
    }
  }
  // Fall back to the last segment for an end offset exactly at the block's length.
  if (isEnd && segments.length > 0) {
    const last = segments[segments.length - 1]!;
    if (at === last.end) return last;
  }
  return null;
}

/** True when every backing Text node of a block is still attached to the document. */
export function isBlockStale(block: BlockRecord): boolean {
  if (!block.owner.isConnected) return true;
  return block.segments.some((s) => !s.node.isConnected);
}
