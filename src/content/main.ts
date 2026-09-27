// Orchestrates the content script: idempotent boot, extraction, the
// extractText/renderHighlights/clearHighlights message handlers T3's popup
// calls (see src/shared/messages.ts), the floating pill, tooltips,
// hidden-Unicode markers, and SPA/mutation staleness handling. Everything is
// wrapped in try/catch so a bug here never breaks the host page.

import { registerHandlers, sendMessage } from "../shared/messages";
import type { AnalyzeResult, ProgressEvent, TextBlock } from "../shared/messages";
import { DEFAULT_SETTINGS, getSettings, watchSettings } from "../shared/settings";
import type { HighlightStyle, Settings } from "../shared/settings";
import { FLAGGED_THRESHOLD } from "./colors";
import { extractVisibleBlocks, getRangeForOffsets, toWireBlocks } from "./extract";
import { renderHighlights as renderPageHighlights, clearHighlights as clearPageHighlights } from "./highlightStyles";
import { buildHoverIndex, hitTestPoint, type HoverIndex } from "./hover";
import { clearImageBadgesIfAvailable, renderImageBadgesIfAvailable } from "./imageBadgesHook";
import { orderFlagged, stepIndex, type FlaggedKey } from "./navigation";
import { startObserving } from "./observe";
import { createPill, type PillApi } from "./pill";
import { extractSelectionBlock } from "./selection";
import { wordCount } from "./segment";
import { formatSentenceTooltip, hideTooltip, showTooltip } from "./tooltip";
import type { ActiveSentence, BlockRecord } from "./types";
import { clearUnicodeMarkers, renderUnicodeMarkers } from "./unicodeMarkers";

const INJECT_FLAG = "__aiDetectorContentBooted";

export function bootContentScript(): void {
  try {
    const w = window as unknown as Record<string, boolean>;
    if (w[INJECT_FLAG]) return;
    w[INJECT_FLAG] = true;
  } catch {
    return;
  }
  void boot().catch(() => {
    // Boot failure (e.g. no document.body yet) -- never throw out of a
    // content script entrypoint.
  });
}

let blocksById = new Map<string, BlockRecord>();
let blockOrder: string[] = [];
let activeSentences: ActiveSentence[] = [];
let flaggedOrder: FlaggedKey[] = [];
let flaggedCursor = -1;
let hoverIndex: HoverIndex | null = null;
let currentStyle: HighlightStyle = DEFAULT_SETTINGS.highlightStyle;
let settings: Settings = DEFAULT_SETTINGS;
let pill: PillApi | null = null;
let lastResult: AnalyzeResult | null = null;

async function boot(): Promise<void> {
  settings = await getSettings().catch(() => DEFAULT_SETTINGS);
  currentStyle = settings.highlightStyle;

  pill = createPill({
    onRun: () => void runFullAnalysis(),
    onClear: () => doClear(),
    onNavigate: (dir) => navigate(dir),
    onStyleChange: (style) => changeStyle(style),
  });
  pill.setIdle();

  watchSettings((next) => {
    settings = next;
  });

  registerHandlers({
    extractText: async ({ target }) => {
      const blocks = doExtract(target);
      pill?.setAnalyzing({ phase: "analyze", loaded: 0, total: 0, message: "Analyzing…" });
      return { blocks };
    },
    renderHighlights: async ({ result, style }) => {
      applyResult(result, style);
      return { ok: true };
    },
    clearHighlights: async () => {
      doClear();
      return { ok: true };
    },
  });

  startObserving(
    () => [...blocksById.values()],
    {
      onStale: () => {
        doClearVisualsOnly();
        pill?.setStale();
      },
      onNavigate: () => {
        doClear();
      },
    },
  );

  document.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("pointerleave", () => hideTooltip());

  if (settings.autoRun) {
    void runFullAnalysis();
  }
}

// ---- Extraction ------------------------------------------------------------

function doExtract(target: "page" | "selection"): TextBlock[] {
  const records = target === "selection" ? selectionRecords() : extractVisibleBlocks(document);
  blocksById = new Map(records.map((r) => [r.id, r]));
  blockOrder = records.map((r) => r.id);
  return toWireBlocks(records);
}

function selectionRecords(): BlockRecord[] {
  const rec = extractSelectionBlock(window);
  return rec ? [rec] : [];
}

// ---- Full local run (pill's own "Scan page" / autoRun / "Scan again") -----

async function runFullAnalysis(): Promise<void> {
  try {
    const blocks = doExtract("page");
    if (blocks.length === 0) {
      pill?.setError("no readable text found on this page.");
      return;
    }
    pill?.setAnalyzing({ phase: "download", loaded: 0, total: 0, message: "Starting…" });
    const result = await sendMessage(
      "analyze",
      // tabId is a placeholder: a content script has no API to learn its own
      // tab id. The background handler should use the sender's tab id
      // (available via registerHandlers' HandlerMeta.senderTabId) rather
      // than trusting this field for content-script-initiated requests.
      { tabId: 0, mode: settings.mode, blocks },
      (progress: ProgressEvent) => pill?.setAnalyzing(progress),
    );
    applyResult(result, settings.highlightStyle);
  } catch (err) {
    pill?.setError(err instanceof Error ? err.message : String(err));
  }
}

// ---- Rendering --------------------------------------------------------------

function applyResult(result: AnalyzeResult, style: HighlightStyle): void {
  try {
    currentStyle = style;
    lastResult = result;
    clearPageHighlights();
    clearUnicodeMarkers();
    hideTooltip();

    activeSentences = [];
    for (const score of result.sentences) {
      const block = blocksById.get(score.blockId);
      if (!block) continue;
      const span = block.sentences[score.index];
      if (!span) continue;
      const range = getRangeForOffsets(block, span.start, span.end);
      if (!range) continue;
      const text = block.text.slice(span.start, span.end);
      activeSentences.push({
        blockId: score.blockId,
        index: score.index,
        range,
        text,
        score: score.score,
        sources: score.sources,
        wordCount: wordCount(text),
        muted: wordCount(text) < settings.minWords,
      });
    }

    renderPageHighlights(activeSentences, style);

    if (settings.showUnicode) {
      for (const block of blocksById.values()) renderUnicodeMarkers(block);
    }

    // Built last: unicode-marker insertion and mark-fallback wrapping can
    // split Text nodes, so the hover index must reflect the final DOM.
    hoverIndex = buildHoverIndex(activeSentences);

    flaggedOrder = orderFlagged(
      activeSentences.filter((s) => s.score >= FLAGGED_THRESHOLD).map((s) => ({ blockId: s.blockId, index: s.index })),
      blockOrder,
    );
    flaggedCursor = -1;

    pill?.setDone({
      overall: result.overall,
      flaggedCount: flaggedOrder.length,
      current: flaggedCursor,
      total: flaggedOrder.length,
      style,
    });

    renderImageBadgesIfAvailable(result);
  } catch (err) {
    pill?.setError(err instanceof Error ? err.message : String(err));
  }
}

function changeStyle(style: HighlightStyle): void {
  try {
    currentStyle = style;
    renderPageHighlights(activeSentences, style);
    hoverIndex = buildHoverIndex(activeSentences);
    if (lastResult) {
      pill?.setDone({
        overall: lastResult.overall,
        flaggedCount: flaggedOrder.length,
        current: flaggedCursor,
        total: flaggedOrder.length,
        style,
      });
    }
  } catch {
    // ignore
  }
}

function doClearVisualsOnly(): void {
  try {
    clearPageHighlights();
    clearUnicodeMarkers();
    hideTooltip();
    clearImageBadgesIfAvailable();
  } catch {
    // ignore
  }
}

function doClear(): void {
  doClearVisualsOnly();
  activeSentences = [];
  flaggedOrder = [];
  flaggedCursor = -1;
  hoverIndex = null;
  lastResult = null;
  pill?.setIdle();
}

// ---- Navigation -------------------------------------------------------------

function navigate(direction: 1 | -1): void {
  try {
    if (flaggedOrder.length === 0) return;
    flaggedCursor = stepIndex(flaggedCursor, flaggedOrder.length, direction);
    pill?.updateCounter(flaggedCursor, flaggedOrder.length);
    const key = flaggedOrder[flaggedCursor];
    if (!key) return;
    const sentence = activeSentences.find((s) => s.blockId === key.blockId && s.index === key.index);
    if (!sentence) return;
    focusFlash(sentence);
  } catch {
    // ignore
  }
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

function focusFlash(sentence: ActiveSentence): void {
  try {
    const rects = sentence.range.getClientRects();
    const rect = rects[0] ?? sentence.range.getBoundingClientRect();
    const targetY = window.scrollY + rect.top - window.innerHeight / 2;
    window.scrollTo({ top: Math.max(0, targetY), behavior: reducedMotion() ? "auto" : "smooth" });
    flashRect(rect);
    const { title, lines } = formatSentenceTooltip(sentence);
    showTooltip(rect, title, lines);
  } catch {
    // ignore
  }
}

function flashRect(rect: DOMRect): void {
  try {
    const el = document.createElement("div");
    const motion = reducedMotion();
    el.style.cssText =
      `position:fixed; left:${rect.left - 4}px; top:${rect.top - 2}px; width:${rect.width + 8}px; ` +
      `height:${rect.height + 4}px; border-radius:4px; pointer-events:none; z-index:2147483600; ` +
      `box-shadow:0 0 0 3px rgba(77,157,255,0.9); ${motion ? "" : "transition: opacity 500ms ease;"} opacity:1;`;
    (document.body ?? document.documentElement).appendChild(el);
    if (!motion) requestAnimationFrame(() => (el.style.opacity = "0"));
    setTimeout(() => el.remove(), motion ? 500 : 650);
  } catch {
    // ignore
  }
}

// ---- Hover tooltips ----------------------------------------------------------

let hoverScheduled = false;

function onPointerMove(e: PointerEvent): void {
  if (hoverScheduled) return;
  hoverScheduled = true;
  requestAnimationFrame(() => {
    hoverScheduled = false;
    try {
      if (!hoverIndex) return;
      const hit = hitTestPoint(e.clientX, e.clientY);
      if (!hit) {
        hideTooltip();
        return;
      }
      const sentence = hoverIndex.lookup(hit.node, hit.offset);
      if (!sentence) {
        hideTooltip();
        return;
      }
      const rects = sentence.range.getClientRects();
      const rect = rects[0] ?? sentence.range.getBoundingClientRect();
      const { title, lines } = formatSentenceTooltip(sentence);
      showTooltip(rect, title, lines);
    } catch {
      // ignore
    }
  });
}
