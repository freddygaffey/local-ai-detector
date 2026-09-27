// Shared DOM-to-text extraction for adapters (chat replies, comments,
// search snippets): walks a subtree collecting visible text the same way
// extract.ts does for the whole page (reusing its whitespace-collapsing
// logic), but rooted at an arbitrary element and with a caller-supplied
// exclusion predicate, so a comment's own text can skip nested replies and a
// chat turn's own text can skip its "Copy"/"Regenerate" buttons.

import { appendCollapsedRun } from "../extract";
import { segmentSentences } from "../segment";
import type { NodeSegment } from "../types";
import type { AdapterBlock, AdapterKind } from "./types";

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
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
  "NAV",
  "FORM",
  "AI-DETECTOR-PILL",
  "AI-DETECTOR-TOOLTIP",
  "AI-DETECTOR-CHIP-HOST",
]);

function isHidden(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  if (el instanceof HTMLElement && el.hidden) return true;
  try {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
  } catch {
    // ignore -- treat as visible
  }
  return false;
}

export interface ExtractedText {
  text: string;
  segments: NodeSegment[];
}

export interface ExtractOptions {
  /** Elements (and their subtrees) to skip, e.g. nested child comments or action buttons. */
  exclude?: (el: Element) => boolean;
}

function walk(node: Node, block: ExtractedText, root: Element, exclude?: (el: Element) => boolean): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node as Text).data;
    if (t.length > 0) appendCollapsedRun(block, node as Text, 0, t);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  if (el !== root) {
    try {
      if (SKIP_TAGS.has(el.tagName)) return;
      if (isHidden(el)) return;
      if (exclude?.(el)) return;
    } catch {
      return;
    }
  }
  const shadow = (el as HTMLElement).shadowRoot ?? null;
  const children = shadow ? Array.from(shadow.childNodes) : Array.from(el.childNodes);
  for (const child of children) walk(child, block, root, exclude);
}

/** Extracts `root`'s own visible text (see ExtractOptions.exclude to skip nested content). */
export function extractElementText(root: Element, opts?: ExtractOptions): ExtractedText {
  const block: ExtractedText = { text: "", segments: [] };
  walk(root, block, root, opts?.exclude);
  return block;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/**
 * Common short UI strings that some generic selectors sweep up along with
 * the real text (a plain-word heuristic, not a full boilerplate remover --
 * see docs/plan.md "generic fallback that excludes ... short UI strings").
 */
const UI_ONLY_TEXT = /^(reply|share|report|save|permalink|edit|delete|copy|regenerate|like|dislike|vote|upvote|downvote|helpful|flag|award|gild|collapse|expand|\d+\s*(points?|upvotes?|likes?|replies?)|\d+[hdwmy]|just now)$/i;

/** Builds an AdapterBlock, or null when there's nothing (or only UI chrome) to score. */
export function finalizeAdapterBlock(
  idPrefix: string,
  label: string,
  kind: AdapterKind,
  owner: Element,
  extracted: ExtractedText,
): AdapterBlock | null {
  const trimmed = extracted.text.trim();
  if (!trimmed || UI_ONLY_TEXT.test(trimmed)) return null;
  const sentences = segmentSentences(extracted.text);
  if (sentences.length === 0) return null;
  return {
    id: nextId(idPrefix),
    text: extracted.text,
    sentences,
    segments: extracted.segments,
    owner,
    label,
    kind,
  };
}

/** Keeps only elements that aren't nested inside another element in the same list (outermost match wins). */
export function outermostOnly(elements: Element[]): Element[] {
  return elements.filter((el) => !elements.some((other) => other !== el && other.contains(el)));
}
