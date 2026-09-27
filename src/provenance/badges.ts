// In-page image badges (content script). A single overlay host holds a
// closed Shadow DOM, so page CSS can't reach our badges and ours can't leak
// out. Badges are position:fixed and follow their images on scroll/resize
// (rAF-throttled). Hover/focus shows a card with the details and the
// honesty wording: missing signals never mean "human-made".

import { NO_SIGNALS_WORDING } from "./schemes";
import type { ImageProvenanceResult, ImageSignal } from "./types";

const HOST_ATTR = "data-local-ai-detector-badges";

interface BadgeEntry {
  element: Element;
  result: ImageProvenanceResult;
  badge: HTMLButtonElement;
}

let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let layer: HTMLDivElement | null = null;
let card: HTMLDivElement | null = null;
let entries: BadgeEntry[] = [];
let rafPending = false;
let listening = false;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

const STYLE = `
:host { all: initial; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
.badge {
  all: initial; position: fixed; box-sizing: border-box; pointer-events: auto; cursor: help;
  font: 600 11px/16px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  padding: 1px 6px; border-radius: 9px; color: #fff; white-space: nowrap;
  box-shadow: 0 1px 3px rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.7);
  letter-spacing: .01em;
}
.badge:focus-visible { outline: 2px solid #1a73e8; outline-offset: 1px; }
.badge.ai-trusted { background: #b3261e; }
.badge.ai { background: #c2410c; }
.badge.edited { background: #a16207; }
.badge.camera { background: #15803d; }
.badge.unknown { background: #475569; }
.card {
  all: initial; position: fixed; box-sizing: border-box; pointer-events: auto; display: none;
  width: min(340px, calc(100vw - 16px)); max-height: min(420px, calc(100vh - 16px)); overflow: auto;
  background: #fff; color: #1a1a1a; border: 1px solid #d0d7de; border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0,0,0,.25); padding: 10px 12px;
  font: 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.card.open { display: block; }
.card h3 { all: unset; display: block; font-weight: 700; font-size: 13px; margin: 0 0 6px; }
.card ul { all: unset; display: block; margin: 0 0 8px; }
.card li { all: unset; display: block; margin: 0 0 6px; padding-left: 8px; border-left: 3px solid #cbd5e1; }
.card li.trusted { border-left-color: #b3261e; }
.card .k { font-weight: 600; }
.card .m { color: #57606a; font-size: 11px; }
.card .foot { color: #57606a; font-size: 11px; border-top: 1px solid #eaeef2; padding-top: 6px; margin-top: 4px; }
.card button { all: unset; cursor: pointer; color: #0969da; font-size: 11px; margin-top: 6px; display: inline-block; }
@media (prefers-color-scheme: dark) {
  .card { background: #1f2328; color: #e6edf3; border-color: #30363d; }
  .card .m, .card .foot { color: #9da7b3; }
  .card .foot { border-top-color: #30363d; }
  .card li { border-left-color: #484f58; }
  .card button { color: #58a6ff; }
}
`;

function ensureHost(): void {
  if (host && host.isConnected) return;
  host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  // Inline style on the host only; everything else lives in the shadow tree.
  host.style.cssText = "all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483646 !important;";
  shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  layer = document.createElement("div");
  layer.className = "layer";
  card = document.createElement("div");
  card.className = "card";
  card.setAttribute("role", "dialog");
  card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  card.addEventListener("mouseleave", scheduleHide);
  shadow.append(style, layer, card);
  (document.documentElement ?? document.body).appendChild(host);
}

const PRIORITY: Record<ImageSignal["kind"], number> = {
  c2pa: 4,
  "invisible-watermark": 3,
  "novelai-alpha": 2,
  metadata: 1,
};

/** The signal that decides the badge text/colour. */
export function primarySignal(signals: ImageSignal[]): ImageSignal | undefined {
  return [...signals].sort((a, b) => {
    const t = Number(b.trusted) - Number(a.trusted);
    if (t) return t;
    const aiA = a.verdict === "ai" || a.verdict === "edited" ? 1 : 0;
    const aiB = b.verdict === "ai" || b.verdict === "edited" ? 1 : 0;
    if (aiA !== aiB) return aiB - aiA;
    return PRIORITY[b.kind] - PRIORITY[a.kind];
  })[0];
}

export function badgeText(result: ImageProvenanceResult): string | null {
  const p = primarySignal(result.signals);
  if (!p) return null;
  const extra = result.signals.length > 1 ? ` +${result.signals.length - 1}` : "";
  return `${p.label}${extra}`;
}

function badgeClass(s: ImageSignal): string {
  if (s.verdict === "ai") return s.trusted ? "ai-trusted" : "ai";
  return s.verdict;
}

/** Plain-language heading per signal (docs/watermarks.md "UI honesty"). */
export function signalHeading(s: ImageSignal): string {
  switch (s.kind) {
    case "c2pa":
      return s.trusted ? "Provenance found (verified signer)" : "Provenance found (untrusted or unknown signer)";
    case "invisible-watermark":
      return "Open-source watermark detected";
    default:
      return "Unsigned AI metadata claim";
  }
}

function text(tag: string, cls: string | null, value: string): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.textContent = value; // never innerHTML: metadata is attacker-controlled
  return el;
}

function fillCard(result: ImageProvenanceResult): void {
  if (!card) return;
  card.replaceChildren();
  card.append(text("h3", null, "Image provenance (checked locally)"));
  const ul = document.createElement("ul");
  for (const s of result.signals) {
    const li = document.createElement("li");
    if (s.trusted) li.className = "trusted";
    li.append(text("div", "k", `${signalHeading(s)}${s.provider ? ` · ${s.provider}` : ""}`));
    li.append(text("div", null, s.detail));
    ul.append(li);
  }
  card.append(ul);
  if (result.c2pa?.signedAt) card.append(text("div", "m", `Signed: ${result.c2pa.signedAt}`));
  const foot = document.createElement("div");
  foot.className = "foot";
  foot.append(
    text(
      "div",
      null,
      "Unsigned claims can be forged or copied. Content Credentials only prove who signed, not that the image is accurate. " +
        NO_SIGNALS_WORDING.replace("No provenance signals found. ", "A missing signal elsewhere "),
    ),
  );
  const hide = document.createElement("button");
  hide.type = "button";
  hide.textContent = "Hide image badges";
  hide.addEventListener("click", () => clearImageBadges());
  foot.append(hide);
  card.append(foot);
}

function openCard(entry: BadgeEntry): void {
  if (!card) return;
  clearTimeout(hideTimer);
  fillCard(entry.result);
  card.classList.add("open");
  const r = entry.badge.getBoundingClientRect();
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - cw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 4;
  if (top + ch > window.innerHeight - 8) top = Math.max(8, r.top - ch - 4);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function scheduleHide(): void {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => card?.classList.remove("open"), 250);
}

function position(entry: BadgeEntry): void {
  const el = entry.element;
  const b = entry.badge;
  if (!el.isConnected) {
    b.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  if (!visible) {
    b.style.display = "none";
    return;
  }
  b.style.display = "block";
  b.style.left = `${Math.max(0, r.left + 6)}px`;
  b.style.top = `${Math.max(0, r.top + 6)}px`;
}

function reposition(): void {
  rafPending = false;
  for (const e of entries) position(e);
}

function scheduleReposition(): void {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(reposition);
}

function startListening(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("scroll", scheduleReposition, { capture: true, passive: true });
  window.addEventListener("resize", scheduleReposition, { passive: true });
}

function stopListening(): void {
  if (!listening) return;
  listening = false;
  window.removeEventListener("scroll", scheduleReposition, { capture: true });
  window.removeEventListener("resize", scheduleReposition);
}

/**
 * Renders (or updates) badges for analysed images. `elements` maps each
 * result's `src` to the page elements showing it; if omitted, <img>
 * elements are matched by currentSrc/src. Images without signals get no
 * badge.
 */
export function renderImageBadgeResults(
  results: ImageProvenanceResult[],
  elements?: Map<string, Element[]>,
): void {
  const withSignals = results.filter((r) => r.status === "ok" && r.signals.length > 0);
  if (!withSignals.length) return;
  ensureHost();
  const map = elements ?? matchImgElements(withSignals.map((r) => r.src));
  for (const result of withSignals) {
    const primary = primarySignal(result.signals)!;
    for (const el of map.get(result.src) ?? []) {
      const existing = entries.find((e) => e.element === el);
      if (existing) {
        existing.result = result;
        existing.badge.textContent = badgeText(result);
        existing.badge.className = `badge ${badgeClass(primary)}`;
        continue;
      }
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = `badge ${badgeClass(primary)}`;
      badge.textContent = badgeText(result);
      badge.setAttribute("aria-label", `Image provenance: ${signalHeading(primary)}. ${primary.detail}`);
      const entry: BadgeEntry = { element: el, result, badge };
      badge.addEventListener("mouseenter", () => openCard(entry));
      badge.addEventListener("focus", () => openCard(entry));
      badge.addEventListener("click", () => openCard(entry));
      badge.addEventListener("mouseleave", scheduleHide);
      badge.addEventListener("blur", scheduleHide);
      layer!.append(badge);
      entries.push(entry);
      position(entry);
    }
  }
  startListening();
}

function matchImgElements(srcs: string[]): Map<string, Element[]> {
  const want = new Set(srcs);
  const map = new Map<string, Element[]>();
  for (const img of Array.from(document.images)) {
    const keys = [img.currentSrc, img.src];
    for (const k of keys) {
      if (k && want.has(k)) {
        const list = map.get(k) ?? [];
        list.push(img);
        map.set(k, list);
        break;
      }
    }
  }
  return map;
}

/** Removes every badge and the overlay host. */
export function clearImageBadges(): void {
  stopListening();
  entries = [];
  clearTimeout(hideTimer);
  host?.remove();
  host = null;
  shadow = null;
  layer = null;
  card = null;
}
