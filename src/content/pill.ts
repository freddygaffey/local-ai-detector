// Floating pill: Shadow DOM (closed mode, own styles, no page CSS leakage),
// draggable and remembers its corner. Shows spinner + phase + % while
// analyzing, then the overall score, flagged count, ▲/▼ navigation with a
// "2/5" counter, a highlight-style toggle, and ✕ to clear. Keyboard
// accessible throughout. A small "i" button explains the caveats.

import { browser } from "wxt/browser";
import { bandWeight, scoreColor } from "./colors";
import type { PillProgress } from "./types";
import type { HighlightStyle, Tier } from "../shared/settings";

const STORAGE_KEY = "aiDetectorPillCorner";
type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const MARGIN = 16;

export interface PillCallbacks {
  onRun(): void;
  onClear(): void;
  onNavigate(direction: 1 | -1): void;
  onStyleChange(style: HighlightStyle): void;
  /** Deep check (docs/plan.md "Two tiers"): the ↻ button next to the score. */
  onDeepCheck(): void;
}

export interface PillApi {
  setIdle(): void;
  setAnalyzing(progress: PillProgress): void;
  /** `overall` is the calibrated display probability (`displayScore(result)`), or null below MIN_WORDS_FOR_SCORE ("—"). */
  setDone(opts: {
    overall: number | null;
    flaggedCount: number;
    current: number;
    total: number;
    style: HighlightStyle;
    /** Docs/plan.md "Two tiers": which pass this result is, and whether a Deep run is in flight (spins the ↻). */
    tier?: Tier;
    deepBusy?: boolean;
  }): void;
  setError(message: string): void;
  updateCounter(current: number, total: number): void;
  setStale(): void;
  /**
   * Docks the pill just above/below the status chip in the chip's corner while
   * the chip is expanded (so the pill never covers the chip's collapse
   * control); `null` restores the user's own corner.
   */
  dockToChip(chipCorner: Corner | null): void;
  destroy(): void;
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

function pillTheme(): "light" | "dark" {
  try {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function css(): string {
  const anim = reducedMotion() ? "none" : "spin 0.9s linear infinite";
  return `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .pill {
      position: fixed;
      font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #202430;
      color: #f2f2f2;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 999px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.35);
      padding: 6px 10px;
      display: flex;
      align-items: center;
      gap: 6px;
      z-index: 2147483000;
      cursor: grab;
      user-select: none;
      max-width: min(92vw, 420px);
    }
    .pill.expanded { border-radius: 14px; align-items: flex-start; flex-direction: column; cursor: default; }
    @media (prefers-color-scheme: light) {
      .pill { background: #ffffff; color: #1a1a1a; border-color: rgba(0,0,0,0.1); box-shadow: 0 6px 20px rgba(0,0,0,0.18); }
    }
    .row { display: flex; align-items: center; gap: 6px; width: 100%; }
    button {
      all: unset;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border-radius: 999px;
      padding: 4px 6px;
      color: inherit;
      min-width: 22px;
      min-height: 22px;
    }
    button:hover, button:focus-visible { background: rgba(127,127,127,0.25); }
    button:focus-visible { outline: 2px solid #4d9dff; outline-offset: 1px; }
    button[aria-pressed="true"] { background: rgba(77,157,255,0.35); }
    .spinner {
      width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid rgba(127,127,127,0.4);
      border-top-color: currentColor;
      animation: ${anim};
      flex: none;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .score { font-weight: 700; } /* colour + weight set inline per score -- see scoreColor()/bandWeight() */
    .muted { opacity: 0.75; font-size: 0.92em; }
    .deep-tag {
      font-size: 0.72em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
      opacity: 0.75; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px;
    }
    .deep-spinning { animation: ${anim}; }
    .counter { font-variant-numeric: tabular-nums; opacity: 0.85; min-width: 2.6em; text-align: center; }
    select { all: unset; background: rgba(127,127,127,0.18); border-radius: 8px; padding: 3px 6px; color: inherit; cursor: pointer; }
    .panel { padding: 8px 10px 4px; max-width: 260px; font-size: 0.92em; opacity: 0.9; }
    .panel ul { margin: 4px 0 0; padding-left: 16px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `;
}

function nearestCorner(rect: DOMRect): Corner {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const vertical = cy < window.innerHeight / 2 ? "top" : "bottom";
  const horizontal = cx < window.innerWidth / 2 ? "left" : "right";
  return `${vertical}-${horizontal}` as Corner;
}

// Room left for the status chip (its margin + height + a gap) when docked to it.
const CHIP_CLEARANCE = 44;

function applyCorner(el: HTMLElement, corner: Corner, extraVertical = 0): void {
  el.style.left = "";
  el.style.right = "";
  el.style.top = "";
  el.style.bottom = "";
  const [v, h] = corner.split("-") as ["top" | "bottom", "left" | "right"];
  el.style[v] = `${MARGIN + extraVertical}px`;
  el.style[h] = `${MARGIN}px`;
}

export function createPill(callbacks: PillCallbacks): PillApi {
  const host = document.createElement("ai-detector-pill-host");
  host.style.cssText = "position:fixed; inset:0; width:0; height:0; pointer-events:none; visibility:visible !important;";
  const shadow = host.attachShadow({ mode: "closed" });
  const styleEl = document.createElement("style");
  styleEl.textContent = css();

  const pill = document.createElement("div");
  pill.className = "pill";
  pill.style.pointerEvents = "auto";
  pill.setAttribute("role", "region");
  pill.setAttribute("aria-label", "AI text detector");

  const live = document.createElement("div");
  live.className = "sr-only";
  live.setAttribute("aria-live", "polite");

  shadow.append(styleEl, pill, live);
  (document.body ?? document.documentElement).appendChild(host);

  let corner: Corner = "bottom-right";
  // While the status chip is expanded, the pill docks next to it (clear of its
  // collapse control) instead of sitting on top of it in the same corner.
  let docked: Corner | null = null;
  const place = () => (docked ? applyCorner(pill, docked, CHIP_CLEARANCE) : applyCorner(pill, corner));
  browser.storage.local
    .get(STORAGE_KEY)
    .then((res: Record<string, unknown>) => {
      const stored = res[STORAGE_KEY];
      if (typeof stored === "string" && ["top-left", "top-right", "bottom-left", "bottom-right"].includes(stored)) {
        corner = stored as Corner;
      }
      place();
    })
    .catch(place);
  place();

  // --- Dragging -----------------------------------------------------------
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  pill.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button, select")) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = pill.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    pill.style.cursor = "grabbing";
    pill.setPointerCapture?.(e.pointerId);
  });
  pill.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    if (!moved) return;
    pill.style.right = "";
    pill.style.bottom = "";
    pill.style.left = `${Math.max(0, Math.min(window.innerWidth - pill.offsetWidth, originLeft + dx))}px`;
    pill.style.top = `${Math.max(0, Math.min(window.innerHeight - pill.offsetHeight, originTop + dy))}px`;
  });
  pill.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    pill.style.cursor = "grab";
    try {
      pill.releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
    if (moved) {
      corner = nearestCorner(pill.getBoundingClientRect());
      docked = null; // the user placed it; stop following the chip
      applyCorner(pill, corner);
      void browser.storage.local.set({ [STORAGE_KEY]: corner }).catch(() => {});
    }
  });

  // --- Rendering ------------------------------------------------------------
  function clear(): void {
    pill.replaceChildren();
    pill.classList.remove("expanded");
  }

  function iconButton(label: string, glyph: string, onClick: () => void, pressed?: boolean): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    if (pressed !== undefined) b.setAttribute("aria-pressed", String(pressed));
    b.textContent = glyph;
    b.addEventListener("click", onClick);
    return b;
  }

  function infoButton(): HTMLButtonElement {
    const b = iconButton("What does this mean?", "ⓘ", () => {
      const panel = pill.querySelector<HTMLDivElement>(".panel");
      if (panel) {
        panel.remove();
        b.setAttribute("aria-expanded", "false");
        return;
      }
      b.setAttribute("aria-expanded", "true");
      const p = document.createElement("div");
      p.className = "panel";
      p.innerHTML =
        "<strong>About this score</strong><ul>" +
        "<li>A probability estimate, not proof of AI authorship.</li>" +
        "<li>Short text (a few sentences) is unreliable.</li>" +
        "<li>English text only -- other languages are not calibrated.</li>" +
        "</ul>";
      pill.appendChild(p);
    });
    b.setAttribute("aria-expanded", "false");
    return b;
  }

  function announce(text: string): void {
    live.textContent = text;
  }

  const api: PillApi = {
    setIdle() {
      clear();
      const row = document.createElement("div");
      row.className = "row";
      const runBtn = iconButton("Scan this page for AI-written text", "▶ Scan page", () => callbacks.onRun());
      runBtn.textContent = "▶ Scan page";
      row.append(runBtn, infoButton());
      pill.appendChild(row);
      announce("Ready to scan.");
    },

    setAnalyzing(progress: PillProgress) {
      clear();
      const row = document.createElement("div");
      row.className = "row";
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      spinner.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      const pct = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : undefined;
      label.textContent = `${phaseLabel(progress)}${pct !== undefined ? ` ${pct}%` : "…"}`;
      row.append(spinner, label);
      pill.appendChild(row);
      announce(label.textContent);
    },

    setDone({ overall, flaggedCount, current, total, style, tier, deepBusy }) {
      clear();
      pill.classList.add("expanded");
      const row = document.createElement("div");
      row.className = "row";
      const score = document.createElement("span");
      score.className = "score";
      if (overall === null) {
        // Below MIN_WORDS_FOR_SCORE: no calibrated number to show at all (see src/ui/probability.ts).
        score.textContent = "AI likelihood —";
      } else {
        // Continuous colour + weight, not a flat per-band swatch, so a
        // borderline score and a confident one look different even within
        // the same band (docs/integration-notes.md "For T12").
        score.style.color = scoreColor(overall, pillTheme());
        score.style.fontWeight = String(bandWeight(overall));
        score.textContent = `AI likelihood ${Math.round(overall * 100)}%`;
      }
      row.appendChild(score);
      if (tier === "deep") {
        const tag = document.createElement("span");
        tag.className = "deep-tag";
        tag.textContent = "Deep";
        row.appendChild(tag);
      }
      const flagged = document.createElement("span");
      flagged.className = "muted";
      flagged.textContent = `· ${flaggedCount} flagged`;
      row.appendChild(flagged);
      const deepBtn = iconButton("Deep check: all models, slower, more battery", "↻", () => callbacks.onDeepCheck());
      if (deepBusy) deepBtn.classList.add("deep-spinning");
      deepBtn.disabled = !!deepBusy;
      row.appendChild(deepBtn);
      pill.appendChild(row);

      const navRow = document.createElement("div");
      navRow.className = "row";
      navRow.append(
        iconButton("Previous flagged sentence", "▲", () => callbacks.onNavigate(-1)),
        (() => {
          const c = document.createElement("span");
          c.className = "counter";
          c.textContent = formatCount(current, total);
          c.dataset.role = "counter";
          return c;
        })(),
        iconButton("Next flagged sentence", "▼", () => callbacks.onNavigate(1)),
      );

      const select = document.createElement("select");
      select.setAttribute("aria-label", "Highlight style");
      for (const [value, label] of [
        ["heatmap", "Heatmap"],
        ["flagged", "Flagged only"],
        ["underline", "Underline"],
      ] as const) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        opt.selected = value === style;
        select.appendChild(opt);
      }
      select.addEventListener("change", () => callbacks.onStyleChange(select.value as HighlightStyle));
      navRow.appendChild(select);

      navRow.append(
        infoButton(),
        iconButton("Clear all highlights", "✕", () => callbacks.onClear()),
      );
      pill.appendChild(navRow);
      announce(`Done. AI likelihood ${overall === null ? "—" : `${Math.round(overall * 100)}%`}. ${flaggedCount} flagged sentences.`);
    },

    setError(message: string) {
      clear();
      const row = document.createElement("div");
      row.className = "row";
      const text = document.createElement("span");
      text.textContent = `Couldn't analyze this page: ${message}`;
      row.append(text, iconButton("Dismiss", "✕", () => callbacks.onClear()));
      pill.appendChild(row);
      announce(text.textContent);
    },

    updateCounter(current: number, total: number) {
      const c = pill.querySelector<HTMLSpanElement>('[data-role="counter"]');
      if (c) c.textContent = formatCount(current, total);
    },

    setStale() {
      if (pill.querySelector(".stale-notice")) return;
      const notice = document.createElement("div");
      notice.className = "stale-notice row";
      const text = document.createElement("span");
      text.className = "muted";
      text.textContent = "Page changed -- highlights cleared.";
      const again = iconButton("Retry", "Retry", () => callbacks.onRun());
      again.textContent = "Retry";
      notice.append(text, again);
      pill.appendChild(notice);
      announce(text.textContent);
    },

    dockToChip(chipCorner) {
      docked = chipCorner;
      place();
    },

    destroy() {
      try {
        host.remove();
      } catch {
        // ignore
      }
    },
  };

  return api;
}

/**
 * No known total during a "download" phase almost always means the model
 * came straight from cache -- a real network fetch reports a byte total
 * quickly. Cache reads never say "Downloading" (mirrors
 * entrypoints/popup/main.ts's `isCacheLoad` / src/ui/state.ts's).
 */
function phaseLabel(progress: PillProgress): string {
  if (progress.phase === "download") {
    return progress.total === 0 ? "Loading model…" : "Downloading model…";
  }
  if (progress.phase === "load") return "Loading model…";
  return "Analyzing…";
}

function formatCount(current: number, total: number): string {
  if (total <= 0) return "0/0";
  const clamped = Math.max(0, Math.min(total - 1, current));
  return `${clamped + 1}/${total}`;
}
