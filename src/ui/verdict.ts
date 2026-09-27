// Score -> band -> wording. Kept pure and separate from rendering so the
// mapping (and its careful, non-accusatory language — see
// docs/feasibility.md §6) is unit-testable on its own.
//
// Wording deliberately avoids accusation: "likely" and "patterns", never
// "is AI" / "plagiarism" / "cheating".

import type { AnalyzeResult } from "../shared/messages";
import type { Settings } from "../shared/settings";

export type Band = "human" | "mixed" | "ai" | "insufficient";

import { FLAGGED_THRESHOLD as AI_MIN, HUMAN_MAX } from "../shared/thresholds";

/** Word count under which a result is too thin to score meaningfully. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export interface BandInput {
  overall: number;
  /**
   * Whether any sentence actually cleared the minWords threshold and got
   * scored. When nothing did, the overall score isn't meaningful.
   */
  hasScoredSentences: boolean;
}

/** Maps an overall AI-likelihood score (plus enough context to know whether
 * there was even enough text) to one of four bands. */
export function scoreToBand(input: BandInput): Band {
  if (!input.hasScoredSentences) return "insufficient";
  if (input.overall < HUMAN_MAX) return "human";
  if (input.overall >= AI_MIN) return "ai";
  return "mixed";
}

export function bandFromResult(result: AnalyzeResult, _settings: Settings): Band {
  return scoreToBand({
    overall: result.overall,
    hasScoredSentences: result.sentences.length > 0,
  });
}

// Terse, label-not-sentence wording (T9 copy pass): the main surfaces show a
// number plus one word, never a caveat or a full sentence. The old
// longer-form BAND_DESCRIPTION lives on as DETAILS_NOTE below -- one fixed
// line, shown only behind the ⓘ/Details affordance.
export const BAND_LABEL: Record<Band, string> = {
  human: "Human",
  mixed: "Mixed",
  ai: "AI",
  insufficient: "Too short",
};

/** One-line note shown once, behind Details -- never repeated on a main surface. */
export const DETAILS_NOTE = "A probability estimate, not proof.";

/** CSS custom-property name carrying this band's colour (see src/ui/styles.css). */
export function bandColorVar(band: Band): string {
  switch (band) {
    case "human":
      return "var(--band-human)";
    case "mixed":
      return "var(--band-mixed)";
    case "ai":
      return "var(--band-ai)";
    case "insufficient":
      return "var(--ink-faint)";
  }
}

export function bandClassName(band: Band): string {
  return `band-${band}`;
}
