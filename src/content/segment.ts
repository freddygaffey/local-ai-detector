// Pure sentence segmentation over a plain string, using Intl.Segmenter.
// Kept separate from DOM extraction (extract.ts) so it is unit-testable
// without a DOM environment (see segment.test.ts).

import type { SentenceRange } from "../shared/messages";

let segmenter: Intl.Segmenter | null = null;
function getSegmenter(): Intl.Segmenter {
  if (!segmenter) segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return segmenter;
}

/**
 * Segments `text` into sentence spans covering the whole string exactly
 * (no gaps, no overlaps -- each span's end is the next span's start), so
 * offsets map back to DOM ranges without drift.
 */
export function segmentSentences(text: string): SentenceRange[] {
  if (text.length === 0) return [];
  const spans: SentenceRange[] = [];
  for (const seg of getSegmenter().segment(text)) {
    const span = { start: seg.index, end: seg.index + seg.segment.length };
    // Citation markers: Intl.Segmenter splits "Europe.[4] They" after the
    // "[", so "4] They …" starts the next sentence. Move "4] " back.
    const prev = spans[spans.length - 1];
    if (prev && text[prev.end - 1] === "[") {
      const m = /^(?:\d{1,4}|[a-z]|note \d{1,3})\]\s*/i.exec(text.slice(span.start, span.end));
      if (m) {
        prev.end += m[0].length;
        span.start += m[0].length;
        if (span.start >= span.end) continue;
      }
    }
    spans.push(span);
  }
  return spans;
}

/** Word count used against settings.minWords to decide "low confidence" styling. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/).length;
}
