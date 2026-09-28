// Status chip (docs/plan.md "T9: Presence modes"): the default presence. A
// tiny corner label -- "AI 91%" on an article, "3 AI" on a comment/thread
// page -- that's fully hidden (not greyed) below the auto-hide threshold, so
// most pages show nothing. A small invisible hover zone in the same corner
// reveals it anyway; clicking it expands into the full inspector (the
// existing pill, via `onExpand`) and a small control on the chip collapses
// back. Closed shadow DOM, like the pill, so page CSS can't leak in or out.

import type { Corner } from "../shared/settings";
import { bandWeight, scoreColor } from "./colors";

const HOTZONE_SIZE = 28;
const MARGIN = 10;

export interface ChipContent {
  /** "AI 91%" (page) or "3 AI" (flagged-item count on a thread/comment page). Null hides the chip (still peekable on hover). */
  label: string | null;
  /** What a hover shows while `label` is null (the below-threshold result, e.g. "AI 34%"); "…" when absent. */
  peekLabel?: string;
  /**
   * The score behind `label` (0..1), when there is a single meaningful one
   * (a page score, not a flagged-item count) -- colours and weights the
   * label so a borderline and a confident score read differently even
   * within the same band (docs/integration-notes.md "For T12").
   */
  score?: number;
}

export interface ChipCallbacks {
  onExpand(): void;
  onCollapse(): void;
}

export interface ChipApi {
  setContent(content: ChipContent): void;
  /** Swaps the chip's own label out for a collapse control while the full inspector (pill) is showing. */
  setExpanded(expanded: boolean): void;
  destroy(): void;
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

function chipTheme(): "light" | "dark" {
  try {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function css(): string {
  return `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .hotzone { position: fixed; width: ${HOTZONE_SIZE}px; height: ${HOTZONE_SIZE}px; pointer-events: auto; }
    .chip {
      position: fixed;
      font: 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-weight: 600;
      background: #202430;
      color: #f2f2f2;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 999px;
      padding: 3px 9px;
      cursor: pointer;
      pointer-events: auto;
      user-select: none;
      z-index: 2147483000;
      opacity: 0;
      transform: scale(0.9);
      transition: ${reducedMotion() ? "none" : "opacity 120ms ease, transform 120ms ease"};
    }
    .chip.visible { opacity: 0.92; transform: scale(1); }
    .chip.stack { white-space: pre-line; border-radius: 7px; font-size: 10.5px; line-height: 1.25; padding: 3px 6px; text-align: left; }
    .chip:hover, .chip:focus-visible { opacity: 1; }
    @media (prefers-color-scheme: light) {
      .chip { background: #ffffff; color: #1a1a1a; border-color: rgba(0,0,0,0.12); box-shadow: 0 2px 8px rgba(0,0,0,0.12); }
    }
  `;
}

function applyCorner(el: HTMLElement, corner: Corner): void {
  el.style.left = "";
  el.style.right = "";
  el.style.top = "";
  el.style.bottom = "";
  const [v, h] = corner.split("-") as ["top" | "bottom", "left" | "right"];
  el.style[v] = `${MARGIN}px`;
  el.style[h] = `${MARGIN}px`;
}

/** Creates the chip, attached but invisible until `setContent` gives it a label or the hotzone is hovered. */
export function createChip(corner: Corner, callbacks: ChipCallbacks): ChipApi {
  const host = document.createElement("ai-detector-chip-host");
  // Our hosts are never-defined custom elements, and some sites (Reddit) hide
  // every `:not(:defined)` element; the inline !important visibility (here and
  // on the pill, tooltip, transcript and voice hosts) keeps them showing.
  host.style.cssText = "position:fixed; inset:0; width:0; height:0; pointer-events:none; visibility:visible !important;";
  const shadow = host.attachShadow({ mode: "closed" });
  const styleEl = document.createElement("style");
  styleEl.textContent = css();

  const hotzone = document.createElement("div");
  hotzone.className = "hotzone";
  applyCorner(hotzone, corner);

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.setAttribute("aria-label", "AI detection result -- click for details");
  applyCorner(chip, corner);

  shadow.append(styleEl, hotzone, chip);
  (document.body ?? document.documentElement).appendChild(host);

  let current: ChipContent = { label: null };
  let expanded = false;
  let peeking = false;

  function render(): void {
    if (expanded) {
      chip.textContent = "×";
      chip.setAttribute("aria-label", "Hide the AI detection panel");
      chip.classList.add("visible");
      return;
    }
    const show = current.label !== null || peeking;
    chip.classList.toggle("visible", show);
    const text = current.label ?? current.peekLabel ?? null;
    chip.textContent = text ?? "…";
    // Multi-line labels (a video's "Script 23%\nVoice 1%") render as a tiny stacked box.
    chip.classList.toggle("stack", !!text && text.includes("\n"));
    chip.setAttribute("aria-label", text ? `AI detection: ${text.replace(/\n/g, ", ")}. Click for details.` : "AI detection: no result yet");
    if (current.score !== undefined && text !== null) {
      chip.style.color = scoreColor(current.score, chipTheme());
      chip.style.fontWeight = String(bandWeight(current.score));
    } else {
      chip.style.color = "";
      chip.style.fontWeight = "";
    }
  }

  hotzone.addEventListener("pointerenter", () => {
    peeking = true;
    render();
  });
  hotzone.addEventListener("pointerleave", () => {
    peeking = false;
    render();
  });
  chip.addEventListener("click", () => {
    if (expanded) callbacks.onCollapse();
    else callbacks.onExpand();
  });

  render();

  return {
    setContent(content: ChipContent) {
      current = content;
      render();
    },
    setExpanded(value: boolean) {
      expanded = value;
      render();
    },
    destroy() {
      try {
        host.remove();
      } catch {
        // ignore
      }
    },
  };
}
