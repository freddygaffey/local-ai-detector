// Per-detector breakdown and flagged-sentence counting for the popup's
// results view. Pure so it's unit-testable independent of rendering.

import type { ScoreSource, SentenceScore } from "../shared/messages";

/** Same threshold as verdict.ts's "ai" band — a sentence scoring at or above
 * this is what "flagged sentences" counts. */
export const FLAG_THRESHOLD = 0.65;

export function countFlaggedSentences(sentences: SentenceScore[], threshold = FLAG_THRESHOLD): number {
  return sentences.filter((s) => s.score >= threshold).length;
}

export const SOURCE_LABEL: Record<ScoreSource, string> = {
  classifier: "Classifier",
  perplexity: "Perplexity / burstiness",
  binoculars: "Binoculars (experimental)",
};

/** Mean score per detector source, across the sentences that reported it. */
export function aggregateSources(sentences: SentenceScore[]): Partial<Record<ScoreSource, number>> {
  const sums: Partial<Record<ScoreSource, number>> = {};
  const counts: Partial<Record<ScoreSource, number>> = {};
  for (const sentence of sentences) {
    for (const [source, value] of Object.entries(sentence.sources) as [ScoreSource, number | undefined][]) {
      if (value === undefined) continue;
      sums[source] = (sums[source] ?? 0) + value;
      counts[source] = (counts[source] ?? 0) + 1;
    }
  }
  const result: Partial<Record<ScoreSource, number>> = {};
  for (const source of Object.keys(sums) as ScoreSource[]) {
    result[source] = sums[source]! / counts[source]!;
  }
  return result;
}
