// Slop filter (docs/plan.md "Slop filter", added by the lead's product
// direction update): on comment/thread/review pages, dim or collapse items
// scoring at/above `settings.slopFilter.threshold`, with a "Show" affordance
// on each. Off by default. Copy is a label, not a sentence -- "AI 88% ·
// Show" -- per the final copy direction (clean, minimal, no caveats on the
// item itself).
//
// Kept independent of highlightStyles.ts (which paints sentences): this
// paints whole adapter blocks (comments/posts/results), using inline styles
// + one shared <style> tag rather than a shadow root per item, since a
// single thread page can have hundreds of them.

import { displayProbability } from "../ui/probability";
import type { SlopFilterSettings } from "../shared/settings";

const MARK_ATTR = "data-ai-detector-slop";
const STYLE_ID = "ai-detector-slop-style";
const BADGE_CLASS = "ai-detector-slop-badge";

export interface SlopItem {
  ownerEl: Element;
  score: number;
  /** Under settings.minWords -- never filtered, regardless of score. */
  tooShort: boolean;
  /**
   * The P(AI) to show for this item, from the detector set that scored it
   * (`toDisplayProbability(score, { ..., level: "unit" })`). Falls back to
   * the default curve when absent.
   */
  probability?: number;
}

function pctOf(item: Pick<SlopItem, "score" | "probability">): number {
  return Math.round((item.probability ?? displayProbability(item.score)) * 100);
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${BADGE_CLASS} {
      all: initial; display: inline-flex !important; align-items: center; gap: 0.4em;
      font: 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      background: #202430; color: #f2f2f2; border-radius: 999px; padding: 2px 8px;
      cursor: pointer; z-index: 2147483000; position: relative; user-select: none;
    }
    @media (prefers-color-scheme: light) { .${BADGE_CLASS} { background: #e8e8ec; color: #1a1a1a; } }
    .${BADGE_CLASS}:hover { filter: brightness(1.1); }
  `;
  document.head?.appendChild(style);
}

function badgeLabel(item: SlopItem): string {
  return `AI ${pctOf(item)}% · Show`;
}

function clearItem(el: Element): void {
  // The badge is always inserted as el's immediately-preceding sibling (see applyOne).
  const badge = el.previousElementSibling;
  if (badge?.classList.contains(BADGE_CLASS) && badge.getAttribute("data-for") === el.getAttribute(MARK_ATTR)) {
    badge.remove();
  }
  (el as HTMLElement).style.removeProperty("display");
  (el as HTMLElement).style.removeProperty("opacity");
  (el as HTMLElement).style.removeProperty("filter");
  el.removeAttribute(MARK_ATTR);
}

let idCounter = 0;

function applyOne(item: SlopItem, style: "dim" | "collapse"): void {
  const el = item.ownerEl;
  const key = `${++idCounter}`;
  if (el.getAttribute(MARK_ATTR)) clearItem(el);
  el.setAttribute(MARK_ATTR, key);

  const badge = document.createElement("span");
  badge.className = BADGE_CLASS;
  badge.setAttribute("data-for", key);
  badge.setAttribute("role", "button");
  badge.tabIndex = 0;
  badge.textContent = badgeLabel(item);
  const show = () => clearItem(el);
  badge.addEventListener("click", show);
  badge.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      show();
    }
  });

  if (style === "collapse") {
    (el as HTMLElement).style.setProperty("display", "none");
    el.before(badge);
  } else {
    (el as HTMLElement).style.setProperty("opacity", "0.35");
    (el as HTMLElement).style.setProperty("filter", "grayscale(60%)");
    el.before(badge);
  }
}

const applied = new Set<Element>();

/** Applies dim/collapse to every item at/above the threshold; clears items that fall below it or are too short. */
export function applySlopFilter(items: SlopItem[], settings: SlopFilterSettings): void {
  if (!settings.enabled) {
    clearSlopFilter();
    return;
  }
  ensureStyle();
  for (const item of items) {
    const shouldFilter = !item.tooShort && item.score >= settings.threshold;
    if (shouldFilter) {
      applyOne(item, settings.style);
      applied.add(item.ownerEl);
    } else if (applied.has(item.ownerEl)) {
      clearItem(item.ownerEl);
      applied.delete(item.ownerEl);
    }
  }
}

const MARKER_CLASS = "ai-detector-search-marker";
const markedResults = new Set<Element>();

/**
 * Search-result markers (docs/plan.md "Slop filter" -> search markers): a
 * small, non-interactive badge next to a flagged snippet -- never dims or
 * hides the result (a search results page is the user's own navigation, not
 * a wall of comments to skim past).
 */
export function applySearchMarkers(items: SlopItem[], threshold: number): void {
  ensureStyle();
  for (const item of items) {
    const already = (item.ownerEl.previousElementSibling as HTMLElement | null)?.classList.contains(MARKER_CLASS);
    const shouldMark = !item.tooShort && item.score >= threshold;
    if (shouldMark && !already) {
      const badge = document.createElement("span");
      badge.className = `${BADGE_CLASS} ${MARKER_CLASS}`;
      badge.textContent = `AI ${pctOf(item)}%`;
      badge.style.cursor = "default";
      item.ownerEl.before(badge);
      markedResults.add(item.ownerEl);
    } else if (!shouldMark && already) {
      item.ownerEl.previousElementSibling?.remove();
      markedResults.delete(item.ownerEl);
    }
  }
}

/** Removes every search marker this module has added. */
export function clearSearchMarkers(): void {
  for (const el of markedResults) {
    try {
      if (el.previousElementSibling?.classList.contains(MARKER_CLASS)) el.previousElementSibling.remove();
    } catch {
      // ignore
    }
  }
  markedResults.clear();
}

const LABEL_CLASS = "ai-detector-item-label";
const labeledItems = new Set<Element>();

/**
 * Per-item inline label ("AI 88%"/"Too short") for chat replies and
 * comments -- shown unconditionally (unlike the slop filter and search
 * markers, which only mark flagged items), the per-reply/per-comment score
 * from docs/plan.md "Chat-site adapters"/"Comment and thread support". The
 * caller excludes items the slop filter is already marking, so an item never
 * gets two badges.
 */
export function renderItemLabels(items: SlopItem[]): void {
  ensureStyle();
  for (const item of items) {
    const existing = item.ownerEl.previousElementSibling;
    if (existing?.classList.contains(LABEL_CLASS)) existing.remove();
    const badge = document.createElement("span");
    badge.className = `${BADGE_CLASS} ${LABEL_CLASS}`;
    badge.style.cursor = "default";
    badge.textContent = item.tooShort ? "Too short" : `AI ${pctOf(item)}%`;
    item.ownerEl.before(badge);
    labeledItems.add(item.ownerEl);
  }
}

/** Removes every per-item label this module has added. */
export function clearItemLabels(): void {
  for (const el of labeledItems) {
    try {
      if (el.previousElementSibling?.classList.contains(LABEL_CLASS)) el.previousElementSibling.remove();
    } catch {
      // ignore
    }
  }
  labeledItems.clear();
}

/** Removes every dim/collapse effect and badge this module has added (SPA navigation, settings toggled off). */
export function clearSlopFilter(): void {
  for (const el of applied) {
    try {
      clearItem(el);
    } catch {
      // element may already be detached
    }
  }
  applied.clear();
}
