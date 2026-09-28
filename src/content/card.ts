// Corner card (docs/plan.md "Primary UI: the corner card"): the default,
// always-present interface on supported pages. Three layers in one closed
// shadow root, all position:fixed in a zero-size host so the page never
// shifts:
//   collapsed  a thumbnail-sized button (<= ~72x48) with a stacked summary,
//              a marker row and a hairline progress bar while checking;
//   hover      a compact card with every essential line (on hover or focus;
//              it stays while the pointer is over the card or it);
//   panel      on click: flagged-item ▲/▼, a highlights toggle for this
//              page, the Deep check ↻, per-detector numbers, Settings, close.
// The text of every layer comes from ./cardSummary.ts (pure, unit-tested).

import type { Corner } from "../shared/settings";
import { bandWeight, scoreColor } from "./colors";
import { collapsedSummary, hoverLines, type CardState, type HoverLine } from "./cardSummary";

const MARGIN = 12;
const GAP = 6;

export interface CardPanelState {
  /** Highlights painted on this page (per visit). */
  highlights: boolean;
  /** Flagged-item cursor (-1 = none yet) and count, for ▲/▼. */
  current: number;
  total: number;
  deepBusy: boolean;
  /** The page's own text can be checked here (article / thread / app). */
  canCheckText: boolean;
  /** A video page with the inline transcript/voice chips to jump to. */
  hasMediaChips: boolean;
}

export interface CardCallbacks {
  onOpen(): void;
  onClose(): void;
  onNavigate(direction: 1 | -1): void;
  onToggleHighlights(): void;
  onDeepCheck(): void;
  onCheckPage(): void;
  onSettings(): void;
  onJumpToMedia(): void;
}

export interface CardApi {
  render(state: CardState, panel: CardPanelState): void;
  updateCounter(current: number, total: number): void;
  setCorner(corner: Corner): void;
  isOpen(): boolean;
  /** Opens the panel (e.g. the context menu asked to reveal a result). */
  open(): void;
  close(): void;
  /** Hides or shows the whole card for this visit (the "toggle visibility" shortcut). */
  setHidden(hidden: boolean): void;
  destroy(): void;
}

function mq(query: string): boolean {
  try {
    return window.matchMedia?.(query).matches ?? false;
  } catch {
    return false;
  }
}

const theme = (): "light" | "dark" => (mq("(prefers-color-scheme: light)") ? "light" : "dark");

function css(): string {
  return `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root {
      --bg: #1b1e24;
      --ink: #eceef2;
      --dim: #9ba2ae;
      --line: rgba(255, 255, 255, 0.11);
      --hover: rgba(255, 255, 255, 0.08);
      --press: rgba(110, 168, 255, 0.28);
      --focus: #6ea8ff;
      --idle: #7d8490;
      --shadow: 0 4px 16px rgba(0, 0, 0, 0.32);
      font: 11px/1.25 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    @media (prefers-color-scheme: light) {
      .root {
        --bg: #fcfcfd;
        --ink: #1e2127;
        --dim: #646b76;
        --line: rgba(20, 24, 32, 0.12);
        --hover: rgba(20, 24, 32, 0.06);
        --press: rgba(40, 110, 220, 0.16);
        --focus: #2a6fdb;
        --idle: #9aa0aa;
        --shadow: 0 3px 12px rgba(20, 24, 32, 0.16);
      }
    }
    .card, .hover, .panel {
      position: fixed;
      z-index: 2147483000;
      pointer-events: auto;
      background: var(--bg);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      color: var(--ink);
    }
    button { font: inherit; color: inherit; }
    .card {
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 1px;
      min-width: 30px;
      max-width: 72px;
      max-height: 48px;
      overflow: hidden;
      padding: 4px 7px 4px 9px;
      border-radius: 7px;
      cursor: pointer;
      text-align: left;
      opacity: 0.94;
      user-select: none;
    }
    /* The worst signal's colour, as a spine down the card's leading edge. */
    .card::before {
      content: "";
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 3px;
      background: var(--accent, var(--idle));
      opacity: 0.9;
    }
    .card:hover, .card:focus-visible, .card[aria-expanded="true"] { opacity: 1; }
    .card:focus-visible, .panel button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .card.idle { min-width: 0; width: 20px; height: 20px; padding: 0; border-radius: 50%; opacity: 0.55; align-items: center; }
    .card.idle::before { display: none; }
    .card.idle .glyph { display: block; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--idle); }
    .glyph { display: none; }
    .ln { display: block; white-space: nowrap; font-size: 11px; line-height: 13px; }
    .ln.sub { color: var(--dim); font-size: 10px; line-height: 12px; }
    .marks { display: flex; gap: 2px; margin-top: 1px; }
    .mk {
      font-size: 8px; line-height: 10px; font-weight: 700; letter-spacing: 0.02em;
      padding: 0 2px; border-radius: 2px; border: 1px solid var(--line); color: var(--dim);
    }
    .bar { position: absolute; left: 3px; right: 0; bottom: 0; height: 2px; overflow: hidden; display: none; }
    .card.running .bar { display: block; }
    .bar i { position: absolute; top: 0; bottom: 0; left: 0; width: 35%; background: var(--focus); opacity: 0.8; }
    .bar i.indet { animation: slide 1.1s ease-in-out infinite; }
    @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(290%); } }

    .hover, .panel {
      width: 212px;
      max-width: calc(100vw - ${MARGIN * 2}px);
      border-radius: 9px;
      padding: 7px 9px;
      font-size: 11.5px;
      line-height: 1.35;
    }
    .hover { pointer-events: auto; }
    [hidden] { display: none !important; }
    .rows { display: grid; grid-template-columns: auto 1fr; column-gap: 10px; row-gap: 2px; }
    .rows .k { color: var(--dim); }
    .rows .v { text-align: right; overflow-wrap: anywhere; }
    .rows .dim { color: var(--dim); }
    .panel { width: 236px; display: flex; flex-direction: column; gap: 6px; }
    .panel .sec { border-top: 1px solid var(--line); padding-top: 6px; }
    .row { display: flex; align-items: center; gap: 4px; }
    .row .grow { flex: 1; }
    .panel button {
      all: unset;
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 22px; min-height: 22px; padding: 0 6px;
      border-radius: 6px; cursor: pointer; font: inherit; color: inherit;
    }
    .panel button:hover { background: var(--hover); }
    .panel button[aria-pressed="true"] { background: var(--press); }
    .panel button:disabled { opacity: 0.45; cursor: default; }
    .panel button.text { color: var(--focus); padding: 0 4px; }
    .counter { min-width: 3em; text-align: center; color: var(--dim); }
    .spin { animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .note { color: var(--dim); font-size: 10.5px; }
    .det { display: grid; grid-template-columns: 1fr auto; column-gap: 10px; row-gap: 1px; }
    .det .k { color: var(--dim); }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    @media (prefers-reduced-motion: reduce) {
      .bar i.indet, .spin { animation: none; }
      .bar i.indet { width: 100%; opacity: 0.45; }
    }
  `;
}

function place(el: HTMLElement, corner: Corner, offset = 0): void {
  el.style.left = el.style.right = el.style.top = el.style.bottom = "";
  const [v, h] = corner.split("-") as ["top" | "bottom", "left" | "right"];
  el.style[v] = `${MARGIN + offset}px`;
  el.style[h] = `${MARGIN}px`;
}

function rowsEl(lines: HoverLine[]): HTMLDivElement {
  const grid = document.createElement("div");
  grid.className = "rows";
  const t = theme();
  for (const l of lines) {
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = l.label;
    const v = document.createElement("span");
    v.className = l.dim ? "v dim" : "v";
    v.textContent = l.value;
    if (l.score !== undefined) {
      v.style.color = scoreColor(l.score, t);
      v.style.fontWeight = String(bandWeight(l.score));
    }
    grid.append(k, v);
  }
  return grid;
}

let cardSeq = 0;

export function createCard(initialCorner: Corner, cb: CardCallbacks): CardApi {
  const id = `aid-card-${++cardSeq}`;
  const host = document.createElement("ai-detector-card-host");
  // Never-defined custom element: some sites hide `:not(:defined)`, hence the inline !important.
  host.style.cssText = "position:fixed; inset:0; width:0; height:0; pointer-events:none; visibility:visible !important; z-index:2147483000;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = css();
  const root = document.createElement("div");
  root.className = "root";

  const card = document.createElement("button");
  card.type = "button";
  card.className = "card";
  card.setAttribute("aria-expanded", "false");
  card.setAttribute("aria-controls", `${id}-panel`);
  card.setAttribute("aria-describedby", `${id}-hover`);

  const hover = document.createElement("div");
  hover.className = "hover";
  hover.id = `${id}-hover`;
  hover.setAttribute("role", "tooltip");
  hover.hidden = true;

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.id = `${id}-panel`;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Detector details");
  panel.hidden = true;

  const live = document.createElement("div");
  live.className = "sr";
  live.setAttribute("aria-live", "polite");

  root.append(card, hover, panel, live);
  shadow.append(style, root);
  (document.body ?? document.documentElement).appendChild(host);

  let corner = initialCorner;
  let open = false;
  let hoverWanted = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let state: CardState = { pageType: "article" };
  let pstate: CardPanelState = { highlights: false, current: -1, total: 0, deepBusy: false, canCheckText: true, hasMediaChips: false };
  let lastSpoken = "";
  let userHidden = false;

  const dockOffset = () => card.getBoundingClientRect().height + GAP;
  function layout(): void {
    place(card, corner);
    const off = dockOffset();
    place(hover, corner, off);
    place(panel, corner, off);
  }

  function renderCard(): void {
    const sum = collapsedSummary(state);
    host.style.display = sum.hidden || userHidden ? "none" : "";
    card.classList.toggle("idle", sum.idle);
    card.classList.toggle("running", sum.running);
    card.setAttribute("aria-label", sum.ariaLabel || "AI detector");
    const t = theme();
    const kids: Node[] = [];
    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.setAttribute("aria-hidden", "true");
    kids.push(glyph);
    sum.lines.forEach((l, i) => {
      const s = document.createElement("span");
      s.className = i > 0 && l.score === undefined && sum.lines[0]?.score !== undefined ? "ln sub" : "ln";
      s.textContent = l.text;
      s.setAttribute("aria-hidden", "true");
      if (l.score !== undefined) {
        s.style.color = scoreColor(l.score, t);
        s.style.fontWeight = String(bandWeight(l.score));
      } else {
        s.style.fontWeight = i === 0 ? "600" : "";
      }
      kids.push(s);
    });
    if (sum.markers.length) {
      const m = document.createElement("span");
      m.className = "marks";
      m.setAttribute("aria-hidden", "true");
      for (const mk of sum.markers.slice(0, 4)) {
        const e = document.createElement("span");
        e.className = "mk";
        e.textContent = mk.code;
        m.appendChild(e);
      }
      kids.push(m);
    }
    const bar = document.createElement("span");
    bar.className = "bar";
    bar.setAttribute("aria-hidden", "true");
    const fill = document.createElement("i");
    if (state.progress !== undefined && state.progress > 0) fill.style.width = `${Math.round(state.progress * 100)}%`;
    else fill.className = "indet";
    bar.appendChild(fill);
    kids.push(bar);
    card.replaceChildren(...kids);
    card.style.setProperty("--accent", sum.worst !== undefined ? scoreColor(sum.worst, t) : "var(--idle)");
    // Announce settled results, not every progress tick.
    const settled = sum.worst !== undefined || sum.lines.some((l) => l.text.includes("—"));
    const spoken = sum.running || !settled ? "" : sum.lines.map((l) => l.text).join(" ");
    if (spoken && spoken !== lastSpoken && !sum.idle) live.textContent = `AI detection: ${spoken}`;
    lastSpoken = spoken || lastSpoken;
  }

  function renderHover(): void {
    hover.replaceChildren(rowsEl(hoverLines(state)));
  }

  function button(label: string, glyph: string, onClick: () => void, opts: { pressed?: boolean; disabled?: boolean; cls?: string } = {}): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = glyph;
    b.title = label;
    b.setAttribute("aria-label", label);
    if (opts.pressed !== undefined) b.setAttribute("aria-pressed", String(opts.pressed));
    if (opts.disabled) b.disabled = true;
    if (opts.cls) b.className = opts.cls;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function renderPanel(): void {
    const kids: HTMLElement[] = [];
    const top = document.createElement("div");
    top.className = "row";
    const title = document.createElement("span");
    title.className = "grow";
    title.style.fontWeight = "600";
    title.textContent = "AI detector";
    const deep = button("Deep check: all models, slower, more battery", "↻", cb.onDeepCheck, { disabled: pstate.deepBusy });
    if (pstate.deepBusy) deep.classList.add("spin");
    top.append(title, deep, button("Close", "×", () => closePanel(true)));
    kids.push(top);
    kids.push(rowsEl(hoverLines(state)));

    const hasText = !!(state.article || state.thread);
    if (hasText) {
      const nav = document.createElement("div");
      nav.className = "row sec";
      const counter = document.createElement("span");
      counter.className = "counter";
      counter.dataset.role = "counter";
      counter.textContent = fmtCount(pstate.current, pstate.total);
      const none = pstate.total === 0;
      nav.append(
        button("Previous flagged item", "▲", () => cb.onNavigate(-1), { disabled: none }),
        counter,
        button("Next flagged item", "▼", () => cb.onNavigate(1), { disabled: none }),
      );
      const spacer = document.createElement("span");
      spacer.className = "grow";
      nav.append(spacer, button("Highlights on this page", "Highlights", cb.onToggleHighlights, { pressed: pstate.highlights }));
      kids.push(nav);
    }

    const dets = state.meta?.detectors ?? [];
    if (dets.length) {
      const sec = document.createElement("div");
      sec.className = "det sec";
      for (const d of dets) {
        const k = document.createElement("span");
        k.className = "k";
        k.textContent = d.label;
        const v = document.createElement("span");
        v.textContent = `${Math.round(d.overall * 100)}`;
        v.title = "Raw detector score (0-100), before calibration";
        sec.append(k, v);
      }
      kids.push(sec);
    }

    const foot = document.createElement("div");
    foot.className = "row sec";
    if (!hasText && pstate.canCheckText) foot.append(button("Check this page's text", "Check page", cb.onCheckPage, { cls: "text" }));
    if (pstate.hasMediaChips) foot.append(button("Show the transcript and voice details", "Details", cb.onJumpToMedia, { cls: "text" }));
    const note = document.createElement("span");
    note.className = "note grow";
    note.textContent = "Probability, not proof.";
    foot.append(note, button("Open settings", "Settings", cb.onSettings, { cls: "text" }));
    kids.push(foot);
    panel.replaceChildren(...kids);
  }

  function showHover(): void {
    clearTimeout(hideTimer);
    if (open) return;
    hoverWanted = true;
    renderHover();
    hover.hidden = false;
    layout();
  }
  function scheduleHide(): void {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hoverWanted = false;
      hover.hidden = true;
    }, 140);
  }

  function openPanel(viaKeyboard: boolean): void {
    open = true;
    hover.hidden = true;
    card.setAttribute("aria-expanded", "true");
    renderPanel();
    panel.hidden = false;
    layout();
    cb.onOpen();
    if (viaKeyboard) panel.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }
  function closePanel(returnFocus: boolean): void {
    if (!open) return;
    open = false;
    panel.hidden = true;
    card.setAttribute("aria-expanded", "false");
    cb.onClose();
    if (returnFocus) card.focus();
  }

  card.addEventListener("pointerenter", showHover);
  card.addEventListener("pointerleave", scheduleHide);
  hover.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  hover.addEventListener("pointerleave", scheduleHide);
  card.addEventListener("focus", () => {
    if (card.matches(":focus-visible")) showHover();
  });
  card.addEventListener("blur", scheduleHide);
  card.addEventListener("click", (e) => {
    if (open) closePanel(false);
    else openPanel(e.detail === 0);
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (open) closePanel(true);
    else hover.hidden = true;
    e.stopPropagation();
  });

  layout();
  renderCard();

  return {
    render(next, p) {
      state = next;
      pstate = p;
      renderCard();
      if (hoverWanted && !hover.hidden) renderHover();
      if (open) {
        const focusedLabel = (shadow.activeElement as HTMLElement | null)?.getAttribute("aria-label");
        renderPanel();
        if (focusedLabel) panel.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(focusedLabel)}"]`)?.focus();
      }
      layout();
    },
    updateCounter(current, total) {
      pstate = { ...pstate, current, total };
      const c = panel.querySelector<HTMLSpanElement>('[data-role="counter"]');
      if (c) c.textContent = fmtCount(current, total);
    },
    setCorner(c) {
      corner = c;
      layout();
    },
    isOpen: () => open,
    open() {
      if (!open) openPanel(false);
    },
    close: () => closePanel(false),
    setHidden(h) {
      userHidden = h;
      if (h) closePanel(false);
      renderCard();
    },
    destroy() {
      clearTimeout(hideTimer);
      try {
        host.remove();
      } catch {
        // ignore
      }
    },
  };
}

function fmtCount(current: number, total: number): string {
  if (total <= 0) return "0/0";
  if (current < 0) return `–/${total}`;
  return `${Math.max(0, Math.min(total - 1, current)) + 1}/${total}`;
}
