// Score -> band -> wording. Kept pure and separate from rendering so the
// mapping (and its careful, non-accusatory language — see
// docs/feasibility.md §6) is unit-testable on its own.
//
// Wording deliberately avoids accusation: "likely" and "patterns", never
// "is AI" / "plagiarism" / "cheating".

import type { AnalyzeResult } from "../shared/messages";
import type { Settings } from "../shared/settings";
import { displayScore } from "./probability";

export type Band = "human" | "mixed" | "ai" | "insufficient";

import type { DisplayContext } from "../shared/thresholds";

/** Word count under which a result is too thin to score meaningfully. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * The band boundaries, on the displayed probability itself (the number the
 * user sees), so the word and the percent can never disagree.
 */
function bandCutoffs(_ctx: DisplayContext): { humanMax: number; aiMin: number } {
  // On the shown number itself: it is already calibrated ("about N% of texts
  // scoring like this were AI"). The engine-score cut points (HUMAN_MAX 0.35,
  // FLAGGED_THRESHOLD 0.5) mapped through the curve landed at ~76% / ~93%
  // shown, so "44% AI" read "no strong AI signal" and "86% AI" only "some".
  return { humanMax: SHOWN_HUMAN_MAX, aiMin: SHOWN_AI_MIN };
}

/** Shown P(AI) below this: "no strong AI signal". */
export const SHOWN_HUMAN_MAX = 0.4;
/** Shown P(AI) from this: "likely AI". */
export const SHOWN_AI_MIN = 0.75;

export interface BandInput {
  /** The number actually shown to the user (0..1, e.g. from `displayScore()`), or null when nothing is shown ("—"). */
  displayed: number | null;
  ctx?: DisplayContext;
}

/** Maps the *displayed* AI-likelihood probability to one of four bands. */
export function scoreToBand(input: BandInput): Band {
  if (input.displayed === null) return "insufficient";
  const { humanMax, aiMin } = bandCutoffs(input.ctx ?? {});
  if (input.displayed < humanMax) return "human";
  if (input.displayed >= aiMin) return "ai";
  return "mixed";
}

export function bandFromResult(result: AnalyzeResult, _settings: Settings): Band {
  if (result.sentences.length === 0) return "insufficient";
  return scoreToBand({
    displayed: displayScore(result),
    ctx: {
      detectors: result.detectors?.map((d) => d.id),
      method: result.fusion?.method,
      device: result.device,
      words: result.words,
    },
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
