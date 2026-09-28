// Toolbar badge: a spinner-ish indicator while analysis runs, then the
// score coloured by band, cleared on navigation or on request. Consumed by
// the background (T1's router calls these as progress/results come in; see
// the one hook-up line in entrypoints/background.ts) and exported here so
// T1 doesn't need to duplicate the band-colour logic.
//
// Pure helpers (`badgeTextForProgress`, `badgeTextForScore`,
// `badgeColorForScore`) are exported separately from the browser-API calls
// so they're unit-testable without a real `browser.action`.

import { browser } from "wxt/browser";
import { scoreHue } from "../content/colors";
import { toPercentInt } from "./format";

// Small "spinner" made of braille-ish dots cycling in the 4-character badge
// space, so the toolbar shows visible motion while analysis is running
// (browser badges can't show real animated icons, this is the next best
// thing) alongside the numeric progress percent when known.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸"];

/** Badge text for an in-progress phase. `pct` 0..100, or undefined for indeterminate progress. */
export function badgeTextForProgress(pct: number | undefined, frame = 0): string {
  const dot = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  if (pct === undefined) return dot!;
  return `${dot}${Math.max(0, Math.min(99, Math.round(pct)))}`;
}

/** Badge text for a finished score (0..1), e.g. "42%" (Chrome fits 4 characters, so "100%" too). */
export function badgeTextForScore(score: number): string {
  return `${toPercentInt(score)}%`;
}

const COLOR_AI = "#b5482f";
const COLOR_NEUTRAL = "#5b6a72";

/** HSL -> "#rrggbb" (browser badge APIs want a concrete colour, not an hsl() string). */
function hslToHex(hue: number, satPct: number, lightPct: number): string {
  const s = satPct / 100;
  const l = lightPct / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Badge background colour for a finished score: a continuous green -> amber
 * -> red scale (src/content/colors.ts `scoreHue`), not three flat swatches --
 * so e.g. a borderline 54% and a confident 97% (both the "ai" band) read
 * differently, not just "AI" vs "not AI" (docs/integration-notes.md "For
 * T12": colour/weight graduation within the AI band).
 */
export function badgeColorForScore(score: number): string {
  return hslToHex(scoreHue(score), 70, 40);
}

/** Badge colour while work is in progress (neutral, not yet a verdict). */
export function badgeColorForProgress(): string {
  return COLOR_NEUTRAL;
}

// Per-tab spinner state, so two tabs analyzing at once don't fight over one
// shared interval/frame counter.
const spinners = new Map<number, { timer: ReturnType<typeof setInterval>; frame: number }>();

function stopSpinner(tabId: number): void {
  const existing = spinners.get(tabId);
  if (existing) {
    clearInterval(existing.timer);
    spinners.delete(tabId);
  }
}

/**
 * Sets the badge to an in-progress indicator for `tabId` and keeps the
 * spinner glyph animating (via `setInterval`) until the next
 * `setBadgeScore`/`setBadgeError`/`clearBadge` call for the same tab. `pct`
 * is 0..100, or omitted for indeterminate phases (e.g. waiting on a model
 * download whose total size isn't known yet).
 */
export function setBadgeProgress(tabId: number, pct?: number): void {
  stopSpinner(tabId);
  const paint = () => {
    const state = spinners.get(tabId);
    const frame = state?.frame ?? 0;
    void browser.action?.setBadgeText?.({ tabId, text: badgeTextForProgress(pct, frame) });
    void browser.action?.setBadgeBackgroundColor?.({ tabId, color: badgeColorForProgress() });
    void browser.action?.setBadgeTextColor?.({ tabId, color: "#ffffff" });
    if (state) state.frame = frame + 1;
  };
  paint();
  const timer = setInterval(paint, 600);
  spinners.set(tabId, { timer, frame: 1 });
}

/** Sets the badge to a finished score (0..1) for `tabId`, coloured by band. */
export function setBadgeScore(tabId: number, score: number): void {
  stopSpinner(tabId);
  void browser.action?.setBadgeText?.({ tabId, text: badgeTextForScore(score) });
  void browser.action?.setBadgeBackgroundColor?.({ tabId, color: badgeColorForScore(score) });
  void browser.action?.setBadgeTextColor?.({ tabId, color: "#ffffff" });
}

/** Sets a short error indicator on the badge for `tabId`. */
export function setBadgeError(tabId: number): void {
  stopSpinner(tabId);
  void browser.action?.setBadgeText?.({ tabId, text: "!" });
  void browser.action?.setBadgeBackgroundColor?.({ tabId, color: COLOR_AI });
  void browser.action?.setBadgeTextColor?.({ tabId, color: "#ffffff" });
}

/** Clears the badge for `tabId` (or globally, if omitted — e.g. on startup). */
export function clearBadge(tabId?: number): void {
  if (tabId !== undefined) stopSpinner(tabId);
  void browser.action?.setBadgeText?.(tabId === undefined ? { text: "" } : { tabId, text: "" });
}
