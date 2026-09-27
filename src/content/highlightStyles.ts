// Renders the three highlight styles (heatmap/flagged/underline) using the
// CSS Custom Highlight API (CSS.highlights / ::highlight()) where available,
// so the page DOM itself isn't mutated. Falls back to wrapping fully
// removable <mark> elements on older engines (pre-Chrome 105 / pre-Firefox
// 140). Styles are switchable live: callers just call renderHighlights()
// again with the same ActiveSentence[] and a new style -- no re-analysis.

import {
  COLOR_BUCKETS,
  bucketScore,
  flaggedColor,
  heatmapColor,
  mutedAlpha,
  sentenceQualifies,
  underlineColor,
  type Theme,
  type ThemeColor,
} from "./colors";
import type { ActiveSentence } from "./types";
import type { HighlightStyle } from "../shared/settings";

const STYLE_TAG_ID = "ai-detector-highlight-style";
const NAME_PREFIX = "ai-detector-hl";

export function supportsCustomHighlight(): boolean {
  try {
    return typeof Highlight !== "undefined" && typeof CSS !== "undefined" && !!CSS.highlights;
  } catch {
    return false;
  }
}

function currentTheme(): Theme {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

function colorFor(style: HighlightStyle, score: number, theme: Theme): ThemeColor {
  if (style === "flagged") return flaggedColor(score, theme);
  if (style === "underline") return underlineColor(score, theme);
  return heatmapColor(score, theme);
}

function highlightName(style: HighlightStyle, muted: boolean, bucket: number): string {
  return `${NAME_PREFIX}-${style}-${muted ? "m" : "n"}${bucket}`;
}

function ruleFor(name: string, color: ThemeColor, style: HighlightStyle, muted: boolean): string {
  // Heatmap/flagged convey level via background tint (+ tooltip text, so it's
  // never colour-only); "muted" (below settings.minWords) additionally gets a
  // dotted underline as a non-colour low-confidence signal on every style,
  // including heatmap/flagged where a normal sentence has no decoration.
  let decoration = "";
  if (style === "underline") {
    decoration = `text-decoration-line: underline; text-decoration-style: ${muted ? "dotted" : "wavy"}; text-decoration-color: ${color.decoration}; text-decoration-thickness: 2px; text-underline-offset: 3px;`;
  } else if (muted) {
    decoration = `text-decoration-line: underline; text-decoration-style: dotted; text-decoration-color: ${color.decoration}; text-underline-offset: 2px;`;
  }
  const bg = style === "underline" ? "" : `background-color: ${color.background};`;
  // The .class rule is for the <mark> fallback: it also has to undo the UA
  // <mark> yellow background and black text.
  const markBg = style === "underline" ? "background-color: transparent;" : bg;
  return `::highlight(${name}) { ${bg} ${decoration} }\nmark.${name} { ${markBg} color: inherit; ${decoration} }`;
}

function buildStylesheet(): string {
  const rules: string[] = [];
  const styles: HighlightStyle[] = ["heatmap", "flagged", "underline"];
  for (const style of styles) {
    for (const muted of [false, true]) {
      for (let bucket = 0; bucket < COLOR_BUCKETS; bucket++) {
        const score = (bucket + 0.5) / COLOR_BUCKETS;
        const lightColor = applyMuted(colorFor(style, score, "light"), muted, "light");
        const darkColor = applyMuted(colorFor(style, score, "dark"), muted, "dark");
        const name = highlightName(style, muted, bucket);
        rules.push(ruleFor(name, lightColor, style, muted));
        rules.push(`@media (prefers-color-scheme: dark) {\n${ruleFor(name, darkColor, style, muted)}\n}`);
      }
    }
  }
  return rules.join("\n");
}

function applyMuted(color: ThemeColor, muted: boolean, theme: Theme): ThemeColor {
  if (!muted) return color;
  // Fade the background but keep the decoration line visible (dotted, set by
  // the caller) so low-confidence sentences read as "present but unreliable"
  // rather than disappearing -- never colour-only.
  const alpha = mutedAlpha(theme);
  const bg = color.background === "transparent" ? color.background : color.background.replace(/[\d.]+\)$/, `${alpha})`);
  return { ...color, background: bg };
}

function ensureStyleTag(): void {
  if (document.getElementById(STYLE_TAG_ID)) return;
  try {
    const el = document.createElement("style");
    el.id = STYLE_TAG_ID;
    el.textContent = buildStylesheet();
    (document.head ?? document.documentElement).appendChild(el);
  } catch {
    // Non-fatal: highlights just won't be visible.
  }
}

export function removeStyleTag(): void {
  try {
    document.getElementById(STYLE_TAG_ID)?.remove();
  } catch {
    // ignore
  }
}

let activeHighlightNames: string[] = [];
let activeMarks: HTMLElement[] = [];

/** Renders (or re-renders, for a live style switch) all given sentences. */
export function renderHighlights(sentences: ActiveSentence[], style: HighlightStyle): void {
  try {
    clearHighlights();
    ensureStyleTag();
    const theme = currentTheme();
    if (supportsCustomHighlight()) {
      renderViaCustomHighlight(sentences, style);
    } else {
      renderViaMarks(sentences, style, theme);
    }
  } catch {
    // Never break the host page.
  }
}

function renderViaCustomHighlight(sentences: ActiveSentence[], style: HighlightStyle): void {
  const groups = new Map<string, Highlight>();
  for (const s of sentences) {
    if (!sentenceQualifies(style, s.score)) continue;
    const bucket = bucketScore(s.score);
    const name = highlightName(style, s.muted, bucket);
    let hl = groups.get(name);
    if (!hl) {
      hl = new Highlight();
      groups.set(name, hl);
    }
    try {
      hl.add(s.range);
    } catch {
      // Range collapsed/detached; skip this sentence.
    }
  }
  for (const [name, hl] of groups) {
    CSS.highlights.set(name, hl);
    activeHighlightNames.push(name);
  }
}

function renderViaMarks(sentences: ActiveSentence[], style: HighlightStyle, _theme: Theme): void {
  // Last sentence first: wrapping one range splits Text nodes, and going
  // backwards means no earlier (not yet wrapped) range depends on live-range
  // fix-ups, which some DOM implementations get wrong.
  for (const s of [...sentences].reverse()) {
    if (!sentenceQualifies(style, s.score)) continue;
    const bucket = bucketScore(s.score);
    const name = highlightName(style, s.muted, bucket);
    try {
      const mark = document.createElement("mark");
      mark.className = `ai-detector-mark ${name}`;
      mark.dataset.aiBlockId = s.blockId;
      mark.dataset.aiIndex = String(s.index);
      // No inline styles here (the old inline `all: revert` also wiped the
      // class rule's colours): the `.${name}` rule resets the UA <mark> look.
      try {
        s.range.surroundContents(mark);
      } catch {
        const frag = s.range.extractContents();
        mark.appendChild(frag);
        s.range.insertNode(mark);
      }
      activeMarks.push(mark);
    } catch {
      // Give up on this one sentence; continue with the rest.
    }
  }
}

/** Removes every highlight/mark this module rendered. Idempotent. */
export function clearHighlights(): void {
  try {
    for (const name of activeHighlightNames) {
      try {
        CSS.highlights?.delete(name);
      } catch {
        // ignore
      }
    }
  } finally {
    activeHighlightNames = [];
  }
  try {
    for (const mark of activeMarks) {
      try {
        mark.replaceWith(...Array.from(mark.childNodes));
      } catch {
        // ignore; leave the mark in place rather than throw
      }
    }
  } finally {
    activeMarks = [];
  }
}

export { reducedMotion, currentTheme };
