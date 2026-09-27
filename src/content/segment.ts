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
    spans.push({ start: seg.index, end: seg.index + seg.segment.length });
  }
  return spans;
}

/** Word count used against settings.minWords to decide "low confidence" styling. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/).length;
}
