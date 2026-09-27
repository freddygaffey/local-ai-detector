// Internal (non-shared) content-script types. Not part of the
// src/shared/messages.ts wire contract -- these describe DOM-side state that
// never crosses the runtime-messaging boundary.

import type { ScoreSource, SentenceRange } from "../shared/messages";

/** A run of a single Text node's data contributing to a block's plain text. */
export interface NodeSegment {
  node: Text;
  /** Offset within `node.data` where this segment's contribution starts. */
  nodeOffset: number;
  /** Offset within the owning block's `text` where this segment starts. */
  start: number;
  /** start + length of the contributed substring. */
  end: number;
}

/**
 * A block of visible text collected from the page (or from the current
 * selection), together with everything needed to map sentence offsets back
 * onto live DOM ranges.
 */
export interface BlockRecord {
  id: string;
  text: string;
  sentences: SentenceRange[];
  segments: NodeSegment[];
  /** Nearest element ancestor, used for staleness checks (isConnected). */
  owner: Element;
}

export interface SentenceKey {
  blockId: string;
  index: number;
}

/** A single sentence, resolved to a live Range, ready to render/tooltip. */
export interface ActiveSentence extends SentenceKey {
  range: Range;
  text: string;
  score: number;
  sources: Partial<Record<ScoreSource, number>>;
  wordCount: number;
  muted: boolean;
}

export type PillPhase = "idle" | "analyzing" | "done" | "error";

export interface PillProgress {
  phase: "download" | "load" | "analyze";
  loaded: number;
  total: number;
  message: string;
}
