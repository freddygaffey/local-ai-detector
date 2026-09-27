// Orchestrates the content script: idempotent boot, extraction, the
// extractText/renderHighlights/clearHighlights message handlers T3's popup
// calls (see src/shared/messages.ts), the Presence surfaces (chip, pill,
// side panel has no page-side component), battery-gated auto-run, chat/
// comment-adapter per-item scoring, the slop filter, site memory, and
// SPA/mutation staleness handling. Everything is wrapped in try/catch so a
// bug here never breaks the host page.

import { onAnalysisStatus, registerHandlers, sendMessage } from "../shared/messages";
import type { AnalyzeResult, SentenceScore, TextBlock } from "../shared/messages";
import { autoRunPolicyForSite, DEFAULT_SETTINGS, getSettings, setSettings, watchSettings } from "../shared/settings";
import type { HighlightStyle, Settings } from "../shared/settings";
import { fusionForTier } from "../engine/models";
import { FLAGGED_THRESHOLD } from "./colors";
// The popup's "Flagged sentences" uses the same function on the same result.
import { countFlaggedSentences } from "../ui/breakdown";
import { bandFromResult } from "../ui/verdict";
import { displayScore, filterThreshold } from "../ui/probability";
import { toDisplayProbability } from "../shared/thresholds";
import { detectSearchResults, detectStructuredContent, isBlockTooShort, type AdapterBlock, type AdapterMatch } from "./adapters";
import { capBlockWords, extractVisibleBlocks, getRangeForOffsets, nextBlockId, proseBlocks, toWireBlocks } from "./extract";
import { extractElementText } from "./adapters/dom";
import { renderHighlights as renderPageHighlights, clearHighlights as clearPageHighlights } from "./highlightStyles";
import { buildHoverIndex, hitTestPoint, type HoverIndex } from "./hover";
import {
  clearImageBadgesIfAvailable,
  renderImageBadgesIfAvailable,
  resetImageBadges,
  scanImagesAndReport,
} from "./imageBadgesHook";
import { checkImageAtUrl } from "./imageContextCheck";
import { orderFlagged, stepIndex, type FlaggedKey } from "./navigation";
import { startObserving } from "./observe";
import { createChip, type ChipApi } from "./chip";
import { createPill, type PillApi } from "./pill";
import { extractSelectionBlock } from "./selection";
import { applySearchMarkers, applySlopFilter, clearSearchMarkers, clearSlopFilter, renderItemLabels, clearItemLabels } from "./slopFilter";
import { recordSiteScore } from "./siteMemory";
import { readBatteryState, readPressureState, decidePowerAction } from "../power/battery";
import { segmentSentences, wordCount } from "./segment";
import { formatSentenceTooltip, hideTooltip, showTooltip } from "./tooltip";
import type { ActiveSentence, BlockRecord } from "./types";
import { clearUnicodeMarkers, renderUnicodeMarkers } from "./unicodeMarkers";
import { runDeepTranscriptCheck, setTranscriptGate, startYouTubeTranscripts } from "./youtube";
import { isYouTubeHost } from "./youtube/acquire";
import { runDeepVoiceCheck, setVoiceGate, startVoiceContent } from "../voice/content";
import { classifyPage, resolvePageType, type PageVerdict } from "./pageType";
import { startSubtitlesPage, startVideoPage, stopPageMedia } from "./pageMedia";
import { pageTypeOverrideForSite } from "../shared/settings";

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
let chip: ChipApi | null = null;
let lastResult: AnalyzeResult | null = null;
let hostname = "";
let structuredMatch: AdapterMatch | null = null;
let searchMatch: AdapterMatch | null = null;
let lastEditableTarget: Element | null = null;

// Transient (per-visit, never persisted) reasons the pill should be showing
// even though Settings.surfaces.highlights is off: the chip was expanded, or
// the popup's "Show on page" (On click preset) was used.
let chipExpanded = false;
let sessionShowOnPage = false;
// Tiers task (docs/plan.md "Two tiers"): whether a Deep run is in flight, so
// the pill's ↻ can spin; cleared once its `renderHighlights` call lands.
let deepBusy = false;

function safeHostname(): string {
  try {
    return location.hostname;
  } catch {
    return "";
  }
}

// ---- Page type routing (src/content/pageType.ts) ------------------------------
//
//   article / thread  page text: the Quick pass automatically, Deep on click
//                     (threads get per-item scores from the adapters)
//   video             transcript + voice chips only (YouTube's own modules, or
//                     src/content/pageMedia.ts elsewhere); never the page text
//   subtitles         the page's cues, scored transcript-style
//   search            snippet markers only
//   app / off         nothing automatic; the popup still checks on click

let page: PageVerdict = { type: "article", reason: "", via: "fallback" };

function classifyNow(): PageVerdict {
  try {
    const raw = classifyPage({ doc: document, url: location.href, viewport: { width: innerWidth, height: innerHeight } });
    return resolvePageType(raw, pageTypeOverrideForSite(settings, hostname));
  } catch {
    return { type: "article", reason: "", via: "fallback" };
  }
}

/** Article or thread: the page's own text is what gets scored. */
function pageTextRoute(): boolean {
  return !page.off && (page.type === "article" || page.type === "thread");
}

let mediaRoute = "";
function applyRoute(): void {
  const media = page.off ? "" : page.type === "video" || page.type === "subtitles" ? `${page.type}|${location.href}` : "";
  setTranscriptGate(() => !page.off && (page.type === "video" || page.type === "subtitles"));
  setVoiceGate(() => !page.off && page.type === "video");
  let youtube = false;
  try {
    youtube = isYouTubeHost(location.hostname);
  } catch {
    // ignore
  }
  if (!youtube && media !== mediaRoute) {
    stopPageMedia();
    if (page.type === "video" && !page.off) startVideoPage(document);
    else if (page.type === "subtitles" && !page.off) startSubtitlesPage(document);
  }
  mediaRoute = media;
  reconcileSurfaces();
}

/** Re-classifies (after navigation, a settings change, or late-rendered content); runs what the new type wants. */
function reroute(opts: { autoRun: boolean }): void {
  const before = page;
  page = classifyNow();
  applyRoute();
  if (!opts.autoRun || (before.type === page.type && before.off === page.off)) return;
  if (pageTextRoute()) void maybeAutoRun();
  if (page.type === "search") void maybeMarkSearchResults();
}

async function boot(): Promise<void> {
  settings = await getSettings().catch(() => DEFAULT_SETTINGS);
  currentStyle = settings.highlightStyle;
  hostname = safeHostname();

  page = classifyNow();

  registerHandlers({
    getPageType: () => ({ ...page, host: hostname }),
    extractText: async ({ target }) => {
      const blocks = doExtract(target);
      pill?.setAnalyzing({ phase: "analyze", loaded: 0, total: 0, message: "Analyzing…" });
      return { blocks, items: target === "page" && structuredMatch !== null };
    },
    renderHighlights: async ({ result, style }) => {
      applyResult(result, style);
      return { ok: true };
    },
    clearHighlights: async () => {
      doClear();
      return { ok: true };
    },
    scanImages: () => scanImagesAndReport(),
    checkImageAtUrl: (req) => checkImageAtUrl(req.srcUrl),
    getSelectionInfo: () => ({ hasSelection: extractSelectionBlock(window) !== null }),
    showOnPage: () => {
      enablePageDisplayForSession();
      return { ok: true };
    },
    scrollToSentence: ({ blockId, index }) => {
      const sentence = activeSentences.find((s) => s.blockId === blockId && s.index === index);
      if (sentence) focusFlash(sentence);
      return { ok: true };
    },
    toggleVisibility: () => {
      if (wantPill()) {
        sessionShowOnPage = false;
        chipExpanded = false;
        chip?.setExpanded(false);
        teardownPillIfUnwanted();
      } else {
        enablePageDisplayForSession();
      }
      return { ok: true };
    },
  });

  document.addEventListener(
    "contextmenu",
    (e) => {
      const t = e.target as Element | null;
      lastEditableTarget = t?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]') ?? null;
    },
    { capture: true },
  );

  watchSettings((next) => {
    const prev = settings;
    settings = next;
    if (next.highlightStyle !== currentStyle && lastResult) changeStyle(next.highlightStyle);
    if (JSON.stringify(prev.pageTypes ?? {}) !== JSON.stringify(next.pageTypes ?? {})) reroute({ autoRun: true });
    if (
      prev.surfaces.chip !== next.surfaces.chip ||
      prev.surfaces.highlights !== next.surfaces.highlights ||
      prev.chipCorner !== next.chipCorner
    ) {
      reconcileSurfaces();
    }
  });

  // Follow the background's per-tab state, whoever started the run (popup,
  // context menu, chip, this pill): progress and errors go to the pill,
  // results arrive separately via renderHighlights.
  onAnalysisStatus((_tabId, status) => {
    if (status.state === "running") {
      pill?.setAnalyzing(status.progress ?? { phase: "download", loaded: 0, total: 0, message: "Starting…" });
    } else if (status.state === "error") {
      pill?.setError(status.error.replace(/^consent-required:\s*/, ""));
    }
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
        resetImageBadges();
        structuredMatch = null;
        searchMatch = null;
        // An SPA navigation (YouTube, Reddit, ...) can change the page type:
        // re-classify, and re-evaluate the chip (docs/plan.md "T4"/"T9").
        reroute({ autoRun: false });
      },
    },
  );

  document.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("pointerleave", () => hideTooltip());

  if (import.meta.env.MODE === "e2e") {
    void import("../e2e/bridge").then(({ installContentBridge }) => installContentBridge());
  }

  applyRoute();
  startYouTubeTranscripts();
  startVoiceContent(); // T11 voice check (standalone; src/voice/content.ts)
  void maybeAutoRun();
  void maybeMarkSearchResults();
  // Late-rendering pages (SPAs) can look empty at document_idle: look again once.
  if (page.via === "fallback") setTimeout(() => reroute({ autoRun: true }), 2500);
}

// ---- Presence surfaces (chip / pill) ---------------------------------------

function wantPill(): boolean {
  const highlightsWanted = settings.surfaces.highlights && !(!pageTextRoute());
  return highlightsWanted || chipExpanded || sessionShowOnPage;
}

function ensurePill(): PillApi {
  if (!pill) {
    pill = createPill({
      onRun: () => void runFullAnalysis(),
      onClear: () => doClear(),
      onNavigate: (dir) => navigate(dir),
      onStyleChange: (style) => {
        changeStyle(style);
        void setSettings({ highlightStyle: style }).catch(() => {});
      },
      onDeepCheck: () => void runDeepCheck(),
    });
    pill.setIdle();
  }
  return pill;
}

function teardownPillIfUnwanted(): void {
  if (!wantPill() && pill) {
    doClearVisualsOnly();
    pill.destroy();
    pill = null;
  }
}

function reconcileSurfaces(): void {
  try {
    const wantChip = settings.surfaces.chip && pageTextRoute();
    if (wantChip && !chip) {
      chip = createChip(settings.chipCorner, {
        onExpand: () => {
          chipExpanded = true;
          ensurePill();
          chip?.setExpanded(true);
          void runFullAnalysis();
        },
        onCollapse: () => {
          chipExpanded = false;
          chip?.setExpanded(false);
          teardownPillIfUnwanted();
        },
      });
    } else if (!wantChip && chip) {
      chip.destroy();
      chip = null;
    }
    if (wantPill()) ensurePill();
    else teardownPillIfUnwanted();
  } catch {
    // never break the page over presence bookkeeping
  }
}

/** Popup's "Show on page" (On click preset): turns the pill + highlights on for this visit only. */
export function enablePageDisplayForSession(): void {
  sessionShowOnPage = true;
  ensurePill();
  void runFullAnalysis();
}

// ---- Extraction ------------------------------------------------------------

function doExtract(target: "page" | "selection" | "editable"): TextBlock[] {
  // Our markers are removed before reading the page, so their text nodes
  // never end up in (and then vanish from) the block mapping.
  clearUnicodeMarkers();
  let records: BlockRecord[];
  if (target === "selection") {
    records = selectionRecords();
  } else if (target === "editable") {
    records = editableRecords();
  } else {
    const structured = detectStructuredContent(document, hostname);
    structuredMatch = structured;
    records = structured ? (structured.blocks as unknown as BlockRecord[]) : proseBlocks(extractVisibleBlocks(document));
  }
  blocksById = new Map(records.map((r) => [r.id, r]));
  blockOrder = records.map((r) => r.id);
  const wire = toWireBlocks(records);
  // Thread pages: score the start of each item rather than the first few
  // items whole, so a long answer doesn't use up the token budget and leave
  // every later comment unscored.
  return target === "page" && structuredMatch ? wire.map((b) => capBlockWords(b, ITEM_WORD_CAP)) : wire;
}

// 150 words: the per-item curves are fitted on texts under 150 words.
const ITEM_WORD_CAP = 150;

function selectionRecords(): BlockRecord[] {
  const rec = extractSelectionBlock(window);
  return rec ? [rec] : [];
}

function editableRecords(): BlockRecord[] {
  const el = lastEditableTarget;
  if (!el) return [];
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const text = el.value ?? "";
    return textOnlyRecord(text, el);
  }
  const extracted = extractElementText(el);
  return textOnlyRecord(extracted.text, el, extracted.segments);
}

function textOnlyRecord(text: string, owner: Element, segments: BlockRecord["segments"] = []): BlockRecord[] {
  if (!text.trim()) return [];
  const sentences = segmentSentences(text);
  if (sentences.length === 0) return [];
  return [{ id: nextBlockId(), text, sentences, segments, owner }];
}

// ---- Full local run (pill's own "Scan page" / autoRun / "Scan again") -----

async function runFullAnalysis(): Promise<void> {
  try {
    pill?.setAnalyzing({ phase: "download", loaded: 0, total: 0, message: "Starting…" });
    await sendMessage("analyzeTab", { target: "page" });
  } catch (err) {
    pill?.setError((err instanceof Error ? err.message : String(err)).replace(/^consent-required:\s*/, ""));
  }
}

/**
 * Deep check (docs/plan.md "Two tiers: Quick (default) and Deep (on
 * demand)"): the pill's ↻. Runs the full detector set (all of
 * `settings.tiers.deepDetectors`) via `analyzeTab`'s tier/fusionOverride
 * channel (src/engine/router.ts), plus the whole YouTube transcript when
 * there's a video on this page. The result replaces the quick score
 * (`applyResult` tags it "Deep" from `AnalyzeResult.tier`).
 */
async function runDeepCheck(): Promise<void> {
  deepBusy = true;
  reRenderPillDone();
  void runDeepTranscriptCheck().catch(() => {});
  runDeepVoiceCheck();
  try {
    const deep = fusionForTier("deep", settings.tiers);
    await sendMessage("analyzeTab", { target: "page", mode: "ensemble", fusionOverride: deep.detectors, tier: "deep" });
  } catch (err) {
    pill?.setError((err instanceof Error ? err.message : String(err)).replace(/^consent-required:\s*/, ""));
  } finally {
    deepBusy = false;
    reRenderPillDone();
  }
}

/** Re-renders the pill's current done view (if any) to pick up `deepBusy`/tier changes without a new analysis. */
function reRenderPillDone(): void {
  if (!lastResult) return;
  pill?.setDone({
    overall: displayScore(lastResult),
    flaggedCount: countFlaggedSentences(lastResult.sentences),
    current: flaggedCursor,
    total: flaggedOrder.length,
    style: currentStyle,
    tier: lastResult.tier,
    deepBusy,
  });
}

// ---- Auto-run (battery-gated, fast mode) -----------------------------------

async function maybeAutoRun(attempt = 0): Promise<void> {
  try {
    // Tiers task (docs/plan.md "Two tiers"): "Run quick check automatically"
    // off means no automatic pass at all -- Deep still runs on click.
    if (!settings.tiers.autoRunQuick) return;
    if (!pageTextRoute()) return; // video/subtitles/search/app: not the page text
    const policy = autoRunPolicyForSite(settings, hostname);
    if (policy !== "always") return; // "never": nothing; "ask" isn't implemented yet (treated as off).
    const [battery, pressure] = await Promise.all([readBatteryState(), readPressureState()]);
    const decision = decidePowerAction(battery, pressure, settings.battery);
    if (decision.pauseAutoRun) {
      chip?.setContent({ label: null });
      // A CPU-pressure spike while the page loads is momentary: try again shortly.
      const at = location.href;
      if (decision.reason === "cpu-pressure" && attempt < 3) setTimeout(() => location.href === at && void maybeAutoRun(attempt + 1), 5000);
      return;
    }
    pill?.setAnalyzing({ phase: "download", loaded: 0, total: 0, message: "Starting…" });
    // The service worker (and Firefox's event page) can't read the Battery
    // Status API themselves, so this content script's own read has to be
    // forwarded (docs/plan.md "T8: Battery saver").
    if (settings.surfaces.highlights && !decision.useLiteModel) {
      // Inspector's always-on pill runs the full configured mode directly
      // (the pre-T9 behaviour); every other preset's automatic pass is Quick
      // (the cheapest detector set, docs/plan.md "Two tiers").
      await sendMessage("analyzeTab", { target: "page", preferCpu: decision.preferCpu });
    } else {
      const quick = fusionForTier("quick", settings.tiers);
      await sendMessage("analyzeTab", {
        target: "page",
        mode: "ensemble",
        fusionOverride: quick.detectors,
        tier: "quick",
        preferCpu: decision.preferCpu,
        confirmWith: settings.tiers.confirmQuick ? settings.fusion.detectors : undefined,
      });
    }
  } catch (err) {
    // Auto-run is best-effort; a manual run still works. Single-page apps
    // (shared chats, some forums) render their text after load: try again.
    const at = location.href;
    if (/readable text/i.test(String(err)) && attempt < 3) {
      setTimeout(() => location.href === at && !lastResult && void maybeAutoRun(attempt + 1), 3000 * (attempt + 1));
    }
  }
}

// ---- Rendering --------------------------------------------------------------

function shouldPaintOnPage(): boolean {
  const highlightsWanted = settings.surfaces.highlights && !(!pageTextRoute());
  return highlightsWanted || chipExpanded || sessionShowOnPage;
}

function applyResult(result: AnalyzeResult, style: HighlightStyle): void {
  try {
    currentStyle = style;
    lastResult = result;
    clearPageHighlights();
    clearUnicodeMarkers();
    hideTooltip();

    activeSentences = [];
    const totalWords = result.sentences.reduce((n, sc) => {
      const b = blocksById.get(sc.blockId);
      const sp = b?.sentences[sc.index];
      return n + (b && sp ? wordCount(b.text.slice(sp.start, sp.end)) : 0);
    }, 0);
    const lowConfidence = totalWords < settings.minWords;

    // Ranges are built regardless of whether anything paints on the page --
    // the side panel's "click a sentence to scroll to it" needs them even
    // when Presence keeps the page itself unmarked (docs/plan.md "Side
    // panel: ... No page marking").
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
        muted: lowConfidence,
        probability: itemProbability(result, score.score),
      });
    }
    if (shouldPaintOnPage()) {
      renderPageHighlights(activeSentences, style);
      if (settings.showUnicode) {
        for (const block of blocksById.values()) renderUnicodeMarkers(block);
      }
      hoverIndex = buildHoverIndex(activeSentences);
    }

    flaggedOrder = orderFlagged(
      result.sentences.filter((s) => s.score >= FLAGGED_THRESHOLD).map((s) => ({ blockId: s.blockId, index: s.index })),
      blockOrder,
    );
    flaggedCursor = -1;

    deepBusy = false;
    pill?.setDone({
      overall: displayScore(result),
      flaggedCount: countFlaggedSentences(result.sentences),
      current: flaggedCursor,
      total: flaggedOrder.length,
      style,
      tier: result.tier,
      deepBusy,
    });

    updateChip(result);
    applyStructuredExtras(result);
    void maybeRecordSiteMemory(result);

    renderImageBadgesIfAvailable();
  } catch (err) {
    pill?.setError(err instanceof Error ? err.message : String(err));
  }
}

function updateChip(result: AnalyzeResult): void {
  if (!chip) return;
  if (chipExpanded) {
    chip.setExpanded(true);
    return;
  }
  if (structuredMatch) {
    const items = perBlockScores(result);
    const flagged = items.filter((i) => !i.tooShort && i.score >= filterThreshold()).length;
    chip.setContent({ label: flagged > 0 ? `${flagged} AI` : null });
    return;
  }
  const score = displayScore(result);
  if (score === null || result.probability === undefined) {
    chip.setContent({ label: null });
    return;
  }
  const pct = Math.round(score * 100);
  const band = bandFromResult(result, settings);
  if (band === "mixed") {
    const flagged = countFlaggedSentences(result.sentences);
    chip.setContent({ label: `AI ${pct}% · ${flagged}/${result.sentences.length}`, score });
    return;
  }
  chip.setContent({ label: pct / 100 >= settings.chipAutoHideThreshold ? `AI ${pct}%` : null, score });
}

interface BlockScoreItem {
  ownerEl: Element;
  score: number;
  tooShort: boolean;
  unscored: boolean;
  probability: number | undefined;
  block: AdapterBlock;
}

/** One item's (comment, review, snippet) shown P(AI): its detector set's paragraph-level curve. */
function itemProbability(result: Pick<AnalyzeResult, "detectors" | "fusion" | "device">, score: number): number {
  return toDisplayProbability(score, {
    detectors: result.detectors?.map((d) => d.id),
    method: result.fusion?.method,
    device: result.device,
    level: "unit",
  });
}

function perBlockScores(result: AnalyzeResult): BlockScoreItem[] {
  if (!structuredMatch) return [];
  const byBlock = new Map<string, SentenceScore[]>();
  for (const s of result.sentences) {
    const list = byBlock.get(s.blockId) ?? [];
    list.push(s);
    byBlock.set(s.blockId, list);
  }
  return structuredMatch.blocks.map((block) => {
    const tooShort = isBlockTooShort(block.text, settings.minWords);
    const scores = byBlock.get(block.id) ?? [];
    const score = scores.length ? scores.reduce((n, s) => n + s.score, 0) / scores.length : 0;
    // Not analysed (past the page's token budget): no number, not "3%".
    const unscored = scores.length === 0;
    return { ownerEl: block.owner, score, tooShort, unscored, probability: unscored ? undefined : itemProbability(result, score), block };
  });
}

function applyStructuredExtras(result: AnalyzeResult): void {
  if (!structuredMatch || !shouldPaintOnPage()) {
    clearSlopFilter();
    clearItemLabels();
    return;
  }
  const items = perBlockScores(result);
  const category = slopCategoryForHost(hostname, structuredMatch.site);
  const filterAllowed = settings.slopFilter.enabled && (category === null || settings.slopFilter.sites[category] !== false);
  if (filterAllowed) {
    applySlopFilter(items, settings.slopFilter);
  } else {
    clearSlopFilter();
  }
  const willFilter = (i: BlockScoreItem) => filterAllowed && !i.tooShort && i.score >= settings.slopFilter.threshold;
  renderItemLabels(items.filter((i) => !willFilter(i)));
}

function slopCategoryForHost(host: string, site: string): "reddit" | "hackernews" | "youtube" | "twitter" | "forum" | "review" | null {
  if (site === "reddit" || /(^|\.)reddit\.com$/.test(host)) return "reddit";
  if (/(^|\.)news\.ycombinator\.com$/.test(host)) return "hackernews";
  if (/(^|\.)youtube\.com$/.test(host)) return "youtube";
  if (/(^|\.)(twitter\.com|x\.com)$/.test(host)) return "twitter";
  if (site === "generic-comments") {
    return document.querySelector('[itemprop="reviewBody"], [class*="review" i]') ? "review" : "forum";
  }
  return null;
}

async function maybeRecordSiteMemory(result: AnalyzeResult): Promise<void> {
  if (!settings.siteMemoryEnabled || structuredMatch || !hostname) return;
  if (result.probability === undefined) return;
  const band = bandFromResult(result, settings);
  await recordSiteScore(hostname, band === "ai").catch(() => {});
}

const SNIPPET_MIN_WORDS = 15;

async function maybeMarkSearchResults(): Promise<void> {
  try {
    if (!settings.slopFilter.searchMarkers || page.off || page.type !== "search") return;
    const match = detectSearchResults(document, hostname);
    searchMatch = match;
    if (!match) return;
    const blocks = toWireBlocks(match.blocks as unknown as BlockRecord[]);
    // The Quick tier's detectors (docs/plan.md "Two tiers"), like every other automatic pass.
    const quick = fusionForTier("quick", settings.tiers);
    const result = await sendMessage("analyze", { tabId: -1, mode: "ensemble", fusionOverride: quick.detectors, tier: "quick", blocks, itemBlocks: true });
    const byBlock = new Map<string, SentenceScore[]>();
    for (const s of result.sentences) byBlock.set(s.blockId, [...(byBlock.get(s.blockId) ?? []), s]);
    const items = match.blocks.map((block) => {
      const scores = byBlock.get(block.id) ?? [];
      const score = scores.length ? scores.reduce((n, s) => n + s.score, 0) / scores.length : 0;
      // Snippets are short by nature (~20-40 words): the page-level minimum
      // (50) would rule every one out, so they get their own, lower floor.
      return {
        ownerEl: block.owner,
        score,
        probability: itemProbability(result, score),
        tooShort: isBlockTooShort(block.text, Math.min(settings.minWords, SNIPPET_MIN_WORDS)),
      };
    });
    applySearchMarkers(items, filterThreshold());
  } catch {
    // Search markers are a small bonus feature; never disrupt the results page over it.
  }
}

function changeStyle(style: HighlightStyle): void {
  try {
    currentStyle = style;
    if (shouldPaintOnPage()) renderPageHighlights(activeSentences, style);
    hoverIndex = buildHoverIndex(activeSentences);
    if (lastResult) {
      pill?.setDone({
        overall: displayScore(lastResult),
        flaggedCount: countFlaggedSentences(lastResult.sentences),
        current: flaggedCursor,
        total: flaggedOrder.length,
        style,
        tier: lastResult.tier,
        deepBusy,
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
    clearSlopFilter();
    clearSearchMarkers();
    clearItemLabels();
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
  sessionShowOnPage = false;
  chipExpanded = false;
  chip?.setExpanded(false);
  chip?.setContent({ label: null });
  pill?.setIdle();
  teardownPillIfUnwanted();
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
