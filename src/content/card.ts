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

import type { CardPosition, Corner } from "../shared/settings";
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
  /** Detector whose sentence scores the highlights show; null = the combined score. */
  highlightBy: string | null;
  /** The page's own text can be checked here (article / thread / app). */
  canCheckText: boolean;
  /** A video page with the inline transcript/voice chips to jump to. */
  hasMediaChips: boolean;
}

/**
 * Where the card sits: anchored to its nearest corner, `dx`/`dy` px in from
 * that corner's side and top/bottom edges (so it stays put across resizes).
 */
export type CardPos = CardPosition;

export const defaultCardPos = (corner: Corner): CardPos => ({ corner, dx: MARGIN, dy: MARGIN });

export interface CardCallbacks {
  onOpen(): void;
  onClose(): void;
  onNavigate(direction: 1 | -1): void;
  onToggleHighlights(): void;
  onHighlightBy(detectorId: string | null): void;
  onDeepCheck(): void;
  onCheckPage(): void;
  onSettings(): void;
  onJumpToMedia(): void;
  /** The user dragged the card to `pos` (persist it for this site). */
  onMoved(pos: CardPos): void;
  /** Panel: make this site's position the default for sites without one. */
  onUsePositionEverywhere(): void;
  /** Panel: forget this site's position (back to the default). */
  onResetPosition(): void;
}

export interface CardApi {
  render(state: CardState, panel: CardPanelState): void;
  updateCounter(current: number, total: number): void;
  /**
   * `exact`: a spot the user chose (kept exactly, no automatic lift over
   * corner widgets); `ownSite`: chosen on this site (the panel offers
   * "Use everywhere" / "Reset").
   */
  setPosition(pos: CardPos, exact: boolean, ownSite: boolean): void;
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
      z-index: 2147483647;
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
    .panel button.primary {
      justify-content: center; min-height: 26px; padding: 0 10px; border-radius: 7px;
      background: var(--focus); color: #fff; font-weight: 600;
    }
    .panel button.primary:hover { filter: brightness(1.08); background: var(--focus); }
    .panel button[aria-pressed="true"] { background: var(--press); }
    .panel button:disabled { opacity: 0.45; cursor: default; }
    .panel button.text { color: var(--focus); padding: 0 4px; }
    .counter { min-width: 3em; text-align: center; color: var(--dim); }
    .spin { animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .note { color: var(--dim); font-size: 10.5px; }
    .det { display: grid; grid-template-columns: 1fr auto; column-gap: 10px; row-gap: 1px; }
    .det .k { color: var(--dim); }
    .card { touch-action: none; }
    .card.dragging { cursor: grabbing; opacity: 0.85; }
    .det.filter { align-items: center; }
    .det .head { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
    .det button.pick { justify-self: start; padding: 1px 6px; color: var(--dim); }
    .det button.pick[aria-pressed="true"] { color: var(--ink); }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    @media (prefers-reduced-motion: reduce) {
      .bar i.indet, .spin { animation: none; }
      .bar i.indet { width: 100%; opacity: 0.45; }
    }
  `;
}

/**
 * How far to lift the card off the viewport edge so it doesn't sit on a site's
 * own fixed corner widget (reCAPTCHA badge, chat bubble, cookie bar, "back to
 * top"). Samples a few points where the card would go and lifts above any
 * foreign fixed/sticky element found there. Full-screen overlays are ignored.
 */
function cornerObstacleOffset(host: Element, corner: Corner): number {
  const [v, h] = corner.split("-") as ["top" | "bottom", "left" | "right"];
  const W = window.innerWidth;
  const H = window.innerHeight;
  const xs = [MARGIN + 6, MARGIN + 36, MARGIN + 66].map((d) => (h === "right" ? W - d : d));
  const ys = [MARGIN + 6, MARGIN + 26, MARGIN + 46].map((d) => (v === "bottom" ? H - d : d));
  let lift = 0;
  for (const x of xs) {
    for (const y of ys) {
      for (const el of document.elementsFromPoint(x, y)) {
        if (el === host || host.contains(el) || el === document.documentElement || el === document.body) continue;
        let node: Element | null = el;
        let fixed: Element | null = null;
        while (node && node !== document.body) {
          const pos = getComputedStyle(node).position;
          if (pos === "fixed" || pos === "sticky") {
            fixed = node;
            break;
          }
          node = node.parentElement;
        }
        if (!fixed) break; // normal page content under the card: fine
        const r = fixed.getBoundingClientRect();
        if (r.width > W * 0.6 && r.height > H * 0.6) break; // a full-screen overlay, not a corner widget
        const need = v === "bottom" ? H - r.top - MARGIN + 8 : r.bottom - MARGIN + 8;
        lift = Math.max(lift, Math.min(need, H * 0.4));
        break;
      }
    }
  }
  return Math.max(0, Math.round(lift));
}

function place(el: HTMLElement, pos: CardPos, offset = 0): void {
  el.style.left = el.style.right = el.style.top = el.style.bottom = "";
  const [v, h] = pos.corner.split("-") as ["top" | "bottom", "left" | "right"];
  el.style[v] = `${pos.dy + offset}px`;
  el.style[h] = `${pos.dx}px`;
}

/** The corner-anchored position for a card whose top-left is at (x, y). */
function posFromRect(x: number, y: number, w: number, h: number): CardPos {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const cx = Math.min(Math.max(x, 0), Math.max(0, W - w));
  const cy = Math.min(Math.max(y, 0), Math.max(0, H - h));
  const right = cx + w / 2 > W / 2;
  const bottom = cy + h / 2 > H / 2;
  return {
    corner: `${bottom ? "bottom" : "top"}-${right ? "right" : "left"}` as Corner,
    dx: Math.round(right ? W - cx - w : cx),
    dy: Math.round(bottom ? H - cy - h : cy),
  };
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

export function createCard(initialPos: CardPos, cb: CardCallbacks): CardApi {
  const id = `aid-card-${++cardSeq}`;
  const host = document.createElement("ai-detector-card-host");
  // Never-defined custom element: some sites hide `:not(:defined)`, hence the inline !important.
  host.style.cssText = "position:fixed; inset:0; width:0; height:0; pointer-events:none; visibility:visible !important; z-index:2147483647;";
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

  let pos = initialPos;
  let custom = false;
  let ownSite = false;
  let open = false;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let state: CardState = { pageType: "article" };
  let pstate: CardPanelState = { highlights: false, current: -1, total: 0, deepBusy: false, highlightBy: null, canCheckText: true, hasMediaChips: false };
  let lastSpoken = "";
  let userHidden = false;

  let lift = 0;
  const dockOffset = () => lift + card.getBoundingClientRect().height + GAP;
  function layout(): void {
    // A position the user chose is kept exactly; the default corner steps around site widgets.
    lift = custom ? 0 : cornerObstacleOffset(host, pos.corner);
    place(card, pos, lift);
    const off = dockOffset();
    place(hover, pos, off);
    place(panel, pos, off);
  }
  // Sites add corner widgets late (reCAPTCHA, chat, cookie bars): re-check now and then.
  let checks = 0;
  const recheck = window.setInterval(() => {
    if (!host.isConnected) return window.clearInterval(recheck);
    if (host.style.display === "none") return;
    if (custom) return;
    const next = cornerObstacleOffset(host, pos.corner);
    if (next !== lift) layout();
    if (++checks > 30) {
      window.clearInterval(recheck);
      window.setInterval(() => host.isConnected && !custom && cornerObstacleOffset(host, pos.corner) !== lift && layout(), 10000);
    }
  }, 2000);

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
    top.append(title, button("Close", "×", () => closePanel(true)));
    kids.push(top);
    kids.push(rowsEl(hoverLines(state)));
    // Deep check: a labelled button, not an icon (all models, whole page/transcript).
    const isDeep = state.meta?.tier === "deep";
    const deepLabel = pstate.deepBusy ? "Deep check running…" : isDeep ? "Deep check again" : "Deep check";
    const deep = button("Deep check: all models, slower, more battery", deepLabel, cb.onDeepCheck, { disabled: pstate.deepBusy, cls: "primary" });
    kids.push(deep);

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
      // Per-detector scores; with 2+ (and text on the page) each is a filter:
      // highlight by that model's sentence scores, or "All" (combined).
      const filter = dets.length > 1 && hasText;
      const sec = document.createElement("div");
      sec.className = `det sec${filter ? " filter" : ""}`;
      const total = state.article?.sentences;
      if (filter) {
        const head = document.createElement("span");
        head.className = "k head";
        head.textContent = "Highlight by model";
        const of = document.createElement("span");
        of.className = "k";
        of.textContent = total !== undefined ? `of ${total} sentences` : "";
        const all = document.createElement("span");
        all.textContent = total !== undefined ? `${state.article?.flagged ?? 0} flagged` : "";
        sec.append(head, of);
        all.title = "Sentences the combined score flags: a weighted average of all the models, so one model alone rarely tips it";
        sec.append(button("Highlight by the combined score (weighted average of the models)", "Combined", () => cb.onHighlightBy(null), { pressed: pstate.highlightBy === null, cls: "pick" }), all);
        const anyV = document.createElement("span");
        anyV.textContent = state.meta?.anyFlagged !== undefined ? `${state.meta.anyFlagged} flagged` : "";
        anyV.title = "Sentences at least one model flags on its own";
        sec.append(button("Highlight every sentence any one model flags", "Any model", () => cb.onHighlightBy("any"), { pressed: pstate.highlightBy === "any", cls: "pick" }), anyV);
      }
      for (const d of dets) {
        const v = document.createElement("span");
        // Sentences this model alone flags as AI, of the page's sentences.
        v.textContent = d.flagged !== undefined ? `${d.flagged} flagged` : "";
        v.title = total !== undefined ? `${d.label} flags ${d.flagged ?? 0} of ${total} sentences as AI` : d.label;
        if (filter && d.id) {
          const id = d.id;
          sec.append(button(`Highlight by ${d.label} only`, d.label, () => cb.onHighlightBy(id), { pressed: pstate.highlightBy === id, cls: "pick" }), v);
        } else {
          const k = document.createElement("span");
          k.className = "k";
          k.textContent = d.label;
          sec.append(k, v);
        }
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
    if (ownSite) {
      const where = document.createElement("div");
      where.className = "row sec";
      const label = document.createElement("span");
      label.className = "note grow";
      label.textContent = "Moved on this site";
      where.append(
        label,
        button("Put the card here on every site you haven't moved it on", "Use everywhere", cb.onUsePositionEverywhere, { cls: "text" }),
        button("Back to the default spot on this site", "Reset", cb.onResetPosition, { cls: "text" }),
      );
      kids.push(where);
    }
    panel.replaceChildren(...kids);
  }

  function showHover(): void {
    clearTimeout(hideTimer);
    if (open) return;
    renderHover();
    hover.hidden = false;
    layout();
  }
  function scheduleHide(): void {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
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
  // Drag to move (a press that travels > 4 px); a plain click still opens the panel.
  let drag: { id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
  let suppressClick = false;
  card.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = card.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
  });
  card.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      try {
        card.setPointerCapture(e.pointerId);
      } catch {
        // synthetic/stale pointer: drag without capture
      }
      card.classList.add("dragging");
      hover.hidden = true;
      if (open) closePanel(false);
    }
    const r = card.getBoundingClientRect();
    pos = posFromRect(drag.ox + dx, drag.oy + dy, r.width, r.height);
    custom = true;
    ownSite = true;
    layout();
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    card.classList.remove("dragging");
    if (moved) {
      suppressClick = true;
      cb.onMoved(pos);
    }
  };
  card.addEventListener("pointerup", endDrag);
  card.addEventListener("pointercancel", endDrag);
  // A release anywhere ends a press that never became a drag: one released off
  // the card (the panel opening under it, another window) used to linger and
  // turn plain hovering into dragging.
  const releaseAnywhere = (e: PointerEvent) => {
    if (drag && e.pointerId === drag.id && !drag.moved) drag = null;
  };
  window.addEventListener("pointerup", releaseAnywhere, true);
  window.addEventListener("blur", () => {
    if (drag && !drag.moved) drag = null;
  });
  card.addEventListener("click", (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
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
      renderHover(); // also the card's aria-describedby text, so keep it current while hidden
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
    setPosition(p, exact, site) {
      if (drag?.moved) return;
      pos = p;
      custom = exact;
      ownSite = site;
      layout();
      if (open) renderPanel();
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
      window.removeEventListener("pointerup", releaseAnywhere, true);
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
