// Entry point for content adapters. `detectStructuredContent` is used by
// src/content/main.ts to decide whether a page gets per-reply/per-comment
// scoring instead of (or alongside) the default whole-page extraction,
// and by the slop filter (src/content/slopFilter.ts) to find what to dim or
// collapse. Adding a new site (e.g. a future YouTube video-page/transcript
// adapter, docs/plan.md "Out of scope for v1" -> v0.2) means adding one more
// entry to STRUCTURED_ADAPTERS below -- nothing else needs to change.

import { extractChatAdapter, isChatHost } from "./chat";
import { extractGenericCommentsAdapter } from "./comments";
import { extractRedditAdapter, isRedditHost } from "./reddit";
import { extractSearchResultsAdapter, searchEngineForHost } from "./search";
import type { AdapterMatch } from "./types";

export * from "./types";
export { isBlockTooShort } from "./comments";
export { isChatHost } from "./chat";
export { isRedditHost } from "./reddit";
export { searchEngineForHost, type SearchEngine } from "./search";

interface StructuredAdapter {
  matches(hostname: string): boolean;
  extract(doc: Document): AdapterMatch | null;
}

const STRUCTURED_ADAPTERS: StructuredAdapter[] = [
  { matches: isChatHost, extract: extractChatAdapter },
  { matches: isRedditHost, extract: extractRedditAdapter },
];

/**
 * Site-specific adapters first (chat, Reddit); the generic comment/thread
 * heuristic otherwise (Hacker News, forums, reviews, YouTube comments, and a
 * plain Reddit fallback if its markup changed). Returns null on an ordinary
 * article/page, which keeps the default whole-page extraction.
 */
export function detectStructuredContent(doc: Document, hostname: string): AdapterMatch | null {
  for (const adapter of STRUCTURED_ADAPTERS) {
    if (adapter.matches(hostname)) {
      const match = adapter.extract(doc);
      if (match) return match;
    }
  }
  return extractGenericCommentsAdapter(doc);
}

/** Search-result snippets (slop filter's search markers) are a separate surface: never mixed into the page's own score. */
export function detectSearchResults(doc: Document, hostname: string): AdapterMatch | null {
  if (!searchEngineForHost(hostname)) return null;
  return extractSearchResultsAdapter(doc, hostname);
}
