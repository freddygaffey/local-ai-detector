// Shared types for content adapters (chat replies, comment/thread structures,
// search-result snippets). See docs/plan.md "Chat-site adapters" and
// "Comment and thread support". Not part of the src/shared/messages.ts wire
// contract -- these describe DOM-side state, the same way src/content/types.ts
// does for the default page extraction.

import type { NodeSegment } from "../types";
import type { SentenceRange } from "../../shared/messages";

export type AdapterKind = "assistant" | "post" | "comment" | "result";

/** One scorable unit: a chat reply, a comment, a post, or a search-result snippet. */
export interface AdapterBlock {
  id: string;
  text: string;
  sentences: SentenceRange[];
  segments: NodeSegment[];
  /** Nearest element ancestor -- used for rendering an inline score badge and for staleness checks. */
  owner: Element;
  /** Short label for display, e.g. "Reply 2", "Comment by u/foo", "Result 3". */
  label: string;
  kind: AdapterKind;
}

/** Result of a structured-content adapter matching the current page. */
export interface AdapterMatch {
  /** Machine id for logging/tests, e.g. "chat", "reddit", "generic-comments", "search-google". */
  site: string;
  blocks: AdapterBlock[];
}
