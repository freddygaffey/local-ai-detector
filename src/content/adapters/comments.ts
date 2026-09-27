// Generic comment/thread/review adapter (docs/plan.md "Comment and thread
// support"): T5's whole-page extraction skips comment sections (they sit
// outside <main>/<article>), so this scores comments, forum posts and
// reviews individually instead of missing them. Covers Hacker News, YouTube
// comments and generic forum/review markup; Reddit has its own adapter
// (reddit.ts) for its more specific structure.
//
// A block under settings.minWords isn't scored -- see isBlockTooShort below,
// used by the caller (src/content/main.ts) to show "Too short" instead of a
// number, the same rule the page-wide analysis already applies.

import { extractElementText, finalizeAdapterBlock, outermostOnly } from "./dom";
import type { AdapterMatch } from "./types";

/**
 * `[class*="x" i]` (case-insensitive attribute selector) matches most
 * comment/review markup without needing a maintained per-site list. Hacker
 * News' static `.commtext` and YouTube's `ytd-comment-renderer #content-text`
 * are added explicitly since neither contains the word "comment" in a class,
 * as are Stack Exchange posts (`.js-post-body`) and Discourse posts (`.cooked`).
 */
const GENERIC_SELECTOR = [
  ".commtext",
  // Stack Exchange question/answer bodies (the generic class patterns only
  // caught the one-line comments under them) and Discourse post bodies.
  ".js-post-body",
  ".topic-post .cooked",
  "ytd-comment-renderer #content-text",
  '[class*="comment-body" i]',
  '[class*="comment-text" i]',
  '[class*="comment-content" i]',
  '[class*="commentcontent" i]',
  '[class*="review-text" i]',
  '[class*="review-body" i]',
  '[itemprop="reviewBody"]',
  "article.comment",
  "li.comment",
].join(", ");

const NON_CONTENT_SELECTOR = 'button, [role="button"], form, time, [class*="avatar" i], [class*="meta" i], [class*="vote" i], [class*="score" i]';

/** True when `block`'s own text is under the minimum word count -- shown as "Too short", never scored. */
export function isBlockTooShort(text: string, minWords: number): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words < minWords;
}

/** Never throws; returns null when nothing comment/review-shaped is on the page. */
export function extractGenericCommentsAdapter(doc: Document): AdapterMatch | null {
  try {
    const found = Array.from(doc.querySelectorAll(GENERIC_SELECTOR));
    if (found.length === 0) return null;
    const items = outermostOnly(found);
    let n = 0;
    const blocks: AdapterMatch["blocks"] = [];
    for (const el of items) {
      n++;
      const extracted = extractElementText(el, {
        // Also skip nested matches of the same selector (e.g. a quoted
        // comment inside another), so a parent's text doesn't double-count
        // a child's -- the child gets scored as its own block instead.
        exclude: (child) => child.matches(NON_CONTENT_SELECTOR) || (child !== el && items.includes(child)),
      });
      const block = finalizeAdapterBlock("comment", `Comment ${n}`, "comment", el, extracted);
      if (block) blocks.push(block);
    }
    if (blocks.length === 0) return null;
    return { site: "generic-comments", blocks };
  } catch {
    return null;
  }
}
