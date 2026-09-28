// Popup: consent screen, main result view (big score + one word, Details
// behind a small disclosure), progress/error/unsupported states, paste box +
// file drop, and the "Show on page" action for the On click preset. See
// src/ui/** for the pure logic this leans on and src/shared/{messages,
// settings}.ts for the background/content-script contract.
//
// Copy direction (final, from the lead): clean and minimal, not hand-holdy.
// Labels, not sentences, on the main surface; one small ⓘ/Details holds the
// "probability, not proof" note, per-detector numbers, device and model
// versions.

import { voiceChecklistRows } from "@/src/voice/checklist";
import "../../src/ui/styles.css";
import "./popup.css";

import { browser } from "wxt/browser";
import { getSettings, isPaused, setSettings, watchSettings } from "@/src/shared/settings";
import type { HighlightStyle, Mode, Settings } from "@/src/shared/settings";
import { CANCELLED_ERROR, CONSENT_REQUIRED_ERROR, NO_SELECTION_ERROR, onAnalysisStatus, sendMessage, sendTabMessage } from "@/src/shared/messages";
import type { AnalyzeResult, ProgressEvent, TabAnalysisStatus } from "@/src/shared/messages";
import { clearChildren, h } from "@/src/ui/dom";
import { derivePopupState, isCacheLoad, isUnsupportedUrl, progressPercent } from "@/src/ui/state";
import type { PopupState } from "@/src/ui/state";
import { offerShowOnPage } from "@/src/ui/optionsLogic";
import { classifyProbe, classifyUrl, parseUnreadable, unreadableMessage, type UnreadableKind } from "@/src/shared/unreadable";
import { BAND_LABEL, bandClassName, bandFromResult, DETAILS_NOTE } from "@/src/ui/verdict";
import { displayScore, formatScoreOrDash } from "@/src/ui/probability";
import { formatBytes, formatPercent, pluralize } from "@/src/ui/format";
import { aggregateSources, countFlaggedSentences, SOURCE_LABEL } from "@/src/ui/breakdown";
import { EXPERIMENTAL_MODES, MODE_LABEL } from "@/src/ui/modelInfo";
import { brandMark, closeIcon, gearIcon, warnIcon } from "@/src/ui/icons";
import { requestImagePermission } from "@/src/provenance/permissions";
import { scanUnicode } from "@/src/detectors/unicode";
import { segmentSentences } from "@/src/content/segment";
import { extractTextFromFile, ACCEPTED_FILE_EXTENSIONS } from "@/src/content/fileExtract";
import { scoreHue } from "@/src/content/colors";
import { mountToastHost, showToast } from "@/src/ui/toast";
import { defaultsChecklistRows, modeDownloadStatus, renderModelChecklist, type CacheKnown } from "@/src/ui/modelChecklist";
import { VOICE_MODELS, VOICE_MODEL_IDS } from "@/src/engine/voiceModels";
import { isVoiceProgress, type VoiceRequest, type VoiceResponse } from "@/src/voice/protocol";
import type { VoiceModelId } from "@/src/voice/aggregate";
import { getSiteTally } from "@/src/content/siteMemory";
import { describeVerdict, PAGE_TYPE_OVERRIDES, type PageTypeOverride, type PageVerdict } from "@/src/content/pageType";
import { collapsedSummary, hoverLines, type CardState } from "@/src/content/cardSummary";
import type { FusionDetector } from "@/src/shared/settings";
import { sanitizeFusion } from "@/src/shared/settings";
import type { ModelSlot } from "@/src/shared/settings";
import { deepCheckRequestFields, deepDownloadStatus, isDeepResult, DEEP_CHECK_TOOLTIP } from "@/src/ui/deepCheck";

interface Ctx {
  settings: Settings;
  tabId: number | null;
  tabUrl: string | null;
  progress: ProgressEvent | null;
  result: AnalyzeResult | null;
  error: string | null;
  lastTarget: "page" | "selection" | null;
  pasteOpen: boolean;
  pauseMenu: boolean;
  moreOpen: boolean;
  pasteBusy: boolean;
  pasteError: string | null;
  /** null until the content script answers (or fails to). Dims "Selection" only once we know it's empty. */
  hasSelection: boolean | null;
  /** Per-slot cache status, for the download checklist and mode-select hints. Undefined until known. */
  cache: CacheKnown | undefined;
  checklistBusy: boolean;
  /** Deep check (docs/plan.md "Two tiers"): the ↻ button's own busy/spin state. */
  deepBusy: boolean;
  /** True once the ↻ click has shown the "download (N MB)" prompt, awaiting a second click to proceed. */
  deepChecklistOpen: boolean;
  /** "Download & enable" in progress (or failed): what it's fetching now. */
  setup: { label: string; message: string; loaded: number; total: number; error?: string } | null;
  voiceCached: Partial<Record<VoiceModelId, boolean>>;
  /** The content script's page-type verdict ("Page: video (YouTube)"), when it answers. */
  pageType: (PageVerdict & { host?: string }) | null;
  /** Site memory (Options, off by default): this site's recent verdicts, once there are a few. */
  siteTally: { high: number; total: number } | null;
  /** Probed: a PDF (even without ".pdf" in the URL) or a page we can't script. */
  unreadable: UnreadableKind | null;
  /** What the corner card knows about this page (the content script's own state). */
  card: CardState | null;
}

const ctx: Ctx = {
  settings: await getSettings(),
  tabId: null,
  tabUrl: null,
  progress: null,
  result: null,
  error: null,
  lastTarget: null,
  pasteOpen: false,
  pauseMenu: false,
  moreOpen: false,
  pasteBusy: false,
  pasteError: null,
  hasSelection: null,
  cache: undefined,
  checklistBusy: false,
  deepBusy: false,
  deepChecklistOpen: false,
  setup: null,
  voiceCached: {},
  pageType: null,
  siteTally: null,
  card: null,
  unreadable: null,
};

const root = document.getElementById("app") as HTMLDivElement;

async function main() {
  mountToastHost();
  void refreshCache();
  const tab = await targetTab();
  ctx.tabId = tab?.id ?? null;
  ctx.tabUrl = tab?.url ?? null;
  render();

  if (ctx.tabId !== null) {
    const tabId = ctx.tabId;
    sendMessage("getTabStatus", { tabId })
      .then((status) => {
        applyStatus(status);
        render();
      })
      .catch(() => {
        // Not implemented yet, or no background listener -- stay idle.
      });
    onAnalysisStatus((eventTabId, status) => {
      if (eventTabId !== tabId) return;
      applyStatus(status);
      render();
    });
    sendTabMessage(tabId, "getPageType", undefined)
      .then(async (v) => {
        if (v.pdf) {
          ctx.unreadable = "pdf";
          render();
          return;
        }
        ctx.pageType = v as PageVerdict & { host?: string };
        const host = tabHostname() ?? ctx.pageType.host;
        if (ctx.settings.siteMemoryEnabled && host) ctx.siteTally = await getSiteTally(host).catch(() => null);
        render();
      })
      .catch((err: unknown) => probeUnreadable(tabId, err));
    // Lead with what's already known about the page (the corner card's state),
    // and keep it fresh while the popup is open (video voice/transcript update live).
    const refreshCard = () =>
      sendTabMessage(tabId, "getCardState", undefined)
        .then((card) => {
          const changed = JSON.stringify(card) !== JSON.stringify(ctx.card);
          ctx.card = card;
          if (changed) render();
        })
        .catch(() => {});
    void refreshCard();
    setInterval(refreshCard, 1500);
    sendTabMessage(tabId, "getSelectionInfo", undefined)
      .then((res) => {
        ctx.hasSelection = res.hasSelection;
        render();
      })
      .catch(() => {
        // No content script yet (e.g. a fresh tab) -- leave the button enabled
        // rather than guess wrong; clicking it will surface the real state.
      });
  }

  watchSettings((settings) => {
    ctx.settings = settings;
    render();
  });
}

/** No content script answered: try a one-line injection. A PDF viewer or protected
 * page refuses it, so the popup shows one quiet line instead of an error later. Never throws. */
async function probeUnreadable(tabId: number, err: unknown): Promise<void> {
  let contentType: string | null = null;
  let probeError: unknown = err;
  try {
    const [r] = await browser.scripting.executeScript({ target: { tabId }, func: () => document.contentType });
    contentType = typeof r?.result === "string" ? r.result : null;
    probeError = undefined;
  } catch (e) {
    probeError = e;
  }
  const kind = classifyProbe({ url: ctx.tabUrl, contentType, probeError });
  if (kind && kind !== ctx.unreadable) {
    ctx.unreadable = kind;
    render();
  }
}

async function refreshCache(): Promise<void> {
  try {
    const info = await sendMessage("getModelCacheInfo", undefined);
    const known: CacheKnown = {};
    for (const [slot, entry] of Object.entries(info.slots) as [ModelSlot, { cached: boolean }][]) {
      known[slot] = entry.cached;
    }
    ctx.cache = known;
    for (const id of VOICE_MODEL_IDS) {
      const r = (await browser.runtime.sendMessage({ kind: "lad-voice", op: "status", model: id } satisfies VoiceRequest).catch(() => undefined)) as VoiceResponse | undefined;
      if (r?.ok && r.cached !== undefined) ctx.voiceCached = { ...ctx.voiceCached, [id]: r.cached };
    }
    render();
  } catch {
    // Cache info isn't critical -- the checklist just won't grey anything out yet.
  }
}

async function targetTab(): Promise<{ id?: number; url?: string } | undefined> {
  const param = new URLSearchParams(location.search).get("tabId");
  if (param && /^\d+$/.test(param)) {
    try {
      return await browser.tabs.get(Number(param));
    } catch {
      // fall through to the active tab
    }
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function applyStatus(status: TabAnalysisStatus): void {
  switch (status.state) {
    case "idle":
      ctx.progress = null;
      ctx.error = null;
      break;
    case "running":
      ctx.progress = status.progress ?? { phase: "analyze", loaded: 0, total: 0, message: "" };
      ctx.error = null;
      break;
    case "done":
      ctx.progress = null;
      ctx.result = status.result;
      ctx.error = null;
      break;
    case "error":
      ctx.progress = null;
      ctx.error = status.error;
      break;
  }
}

function currentState(): PopupState {
  return derivePopupState({
    consentedDownload: ctx.settings.consentedDownload,
    tabUrl: ctx.tabId !== null && !ctx.tabUrl ? "https://url-not-visible.invalid/" : ctx.tabUrl,
    progress: ctx.progress,
    result: ctx.result,
    error: ctx.error,
    unreadable: ctx.unreadable,
  });
}

function render(): void {
  clearChildren(root);
  const state = currentState();
  root.append(renderHeader());
  const pause = renderPauseRow();
  if (pause) root.append(pause);
  if (ctx.setup) {
    root.append(renderConsentChecklist());
    return;
  }
  switch (state) {
    case "consent":
      root.append(renderConsent());
      break;
    case "unsupported":
      root.append(renderUnsupported());
      break;
    case "downloading":
    case "loading":
    case "analyzing":
      root.append(renderProgress());
      break;
    case "error":
      root.append(renderErrorView());
      break;
    case "idle":
    case "done":
      root.append(renderMain());
      break;
  }
}

// ---- Header / footer ----

function renderHeader(): HTMLElement {
  return h(
    "header",
    { class: "popup-header" },
    brandMark(),
    h("h1", null, "Local AI Detector"),
    h(
      "button",
      {
        class: `icon-btn pause-btn${isPaused(ctx.settings) ? " is-paused" : ""}`,
        type: "button",
        "aria-label": "Pause automatic checks",
        "aria-expanded": String(ctx.pauseMenu),
        title: "Pause automatic checks (saves battery)",
        onclick: () => {
          ctx.pauseMenu = !ctx.pauseMenu;
          render();
        },
      },
      "⏸",
    ),
    h(
      "button",
      { class: "icon-btn", type: "button", "aria-label": "Settings", title: "Settings", onclick: openOptions },
      gearIcon(),
    ),
  );
}

/** "Paused until 18:40 · Resume", or the ⏸ menu's 1 h / 5 h / 12 h choices. */
function renderPauseRow(): HTMLElement | null {
  const paused = isPaused(ctx.settings);
  if (paused) {
    const until = new Date(ctx.settings.pausedUntil);
    const sameDay = until.toDateString() === new Date().toDateString();
    const when = until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + (sameDay ? "" : " tomorrow");
    return h(
      "div",
      { class: "pause-row" },
      h("span", { class: "grow" }, `Automatic checks paused until ${when}`),
      h("button", { class: "btn btn-ghost btn-small", type: "button", onclick: () => void setPause(0) }, "Resume"),
    );
  }
  if (!ctx.pauseMenu) return null;
  return h(
    "div",
    { class: "pause-row" },
    h("span", { class: "grow", title: "Pause automatic checks (manual checks still work)" }, "Pause for"),
    ...[1, 5, 12].map((hours) =>
      h("button", { class: "btn btn-ghost btn-small", type: "button", onclick: () => void setPause(hours) }, `${hours} h`),
    ),
  );
}

async function setPause(hours: number): Promise<void> {
  ctx.pauseMenu = false;
  ctx.settings = await setSettings({ pausedUntil: hours > 0 ? Date.now() + hours * 3_600_000 : 0 });
  render();
  if (hours > 0) showToast(`Paused for ${hours} h. Manual checks still work.`);
}

function openOptions(): void {
  // Fallback: open the page as a tab if the options API fails (it has in the wild).
  void browser.runtime
    .openOptionsPage()
    .catch(() => browser.tabs.create({ url: browser.runtime.getURL("/options.html") }))
    .then(() => window.close())
    .catch(() => {});
}

// ---- Consent (model download checklist; no paragraphs) ----

/**
 * First-run checklist: every model the defaults use (the Quick tier's lite
 * model, the click-to-run Fusion set, the voice model), all ticked, sizes +
 * roles + a running total. "Download & enable" fetches them all now, with
 * progress, instead of leaving them to the first check.
 */
function renderConsentChecklist(): HTMLElement {
  const rows = defaultsChecklistRows(ctx.settings, "wasm", ctx.cache);
  const body = h(
    "div",
    { class: "popup-body consent" },
    h("p", { class: "field-hint" }, "Models:"),
    renderModelChecklist({
      rows,
      onToggle: (id, checked) => void onConsentToggle(id, checked),
      onDownload: ctx.setup ? undefined : () => void onConsent(),
      downloadLabel: "Download & enable",
      busy: ctx.checklistBusy,
      extraRows: voiceChecklistRows(ctx.settings.voice, (voice) => void setSettings({ voice }).then((s) => ((ctx.settings = s), render())), ctx.voiceCached),
    }),
  );
  if (ctx.setup) body.append(renderSetupProgress(ctx.setup));
  return body;
}

function renderSetupProgress(setup: NonNullable<Ctx["setup"]>): HTMLElement {
  const pct = setup.total > 0 ? Math.min(100, Math.round((100 * setup.loaded) / setup.total)) : null;
  return h(
    "div",
    { class: "progress-panel" },
    h("div", { class: "phase" }, setup.error ? "Download failed" : setup.label),
    h("div", { class: `progress-bar${pct === null ? " indeterminate" : ""}` }, h("span", { style: `width:${pct ?? 40}%` })),
    h(
      "div",
      { class: "detail" },
      h("span", { class: "message", title: setup.error ?? setup.message }, setup.error ?? setup.message),
      h("span", { class: "num" }, pct !== null ? `${formatBytes(setup.loaded)} / ${formatBytes(setup.total)}` : ""),
    ),
  );
}

function renderConsent(): HTMLElement {
  return renderConsentChecklist();
}

async function onConsentToggle(id: FusionDetector, checked: boolean): Promise<void> {
  const row = defaultsChecklistRows(ctx.settings, "wasm", ctx.cache).find((r) => r.id === id);
  if (!row || row.locked) return;
  if (row.tier === "quick") {
    const q = ctx.settings.tiers.quickDetectors;
    const next = checked ? [...new Set([...q, id])] : q.filter((d) => d !== id);
    if (next.length === 0) return;
    ctx.settings = await setSettings({ tiers: { ...ctx.settings.tiers, quickDetectors: next } });
  } else {
    const current = ctx.settings.fusion.detectors;
    const next = checked ? [...new Set([...current, id])] : current.filter((d) => d !== id);
    if (next.length === 0) return; // keep at least one
    ctx.settings = await setSettings({ fusion: sanitizeFusion({ ...ctx.settings.fusion, detectors: next }) });
  }
  render();
}

// Something short and neutral to push through the detectors once, which
// makes the engine fetch, verify and cache every checked text model.
const WARMUP_TEXT =
  "The library opens at nine on weekdays and at ten on weekends. Members can borrow up to six books at a time, " +
  "and most loans last three weeks. If a book is overdue, a small fee is added for each day it is late. " +
  "Study rooms can be booked at the front desk, and there is free wifi throughout the building for everyone who visits.";

async function onConsent(): Promise<void> {
  const rows = defaultsChecklistRows(ctx.settings, "wasm", ctx.cache);
  ctx.setup = { label: "Downloading", message: "Starting…", loaded: 0, total: 0 };
  ctx.checklistBusy = true;
  render();
  try {
    await setSettings({ consentedDownload: true });
    // 1. Text models (one pass through every checked detector).
    const text = WARMUP_TEXT;
    await sendMessage(
      "analyze",
      {
        tabId: -1,
        mode: "ensemble",
        fusionOverride: rows.filter((r) => r.checked).map((r) => r.id),
        blocks: [{ id: "warmup", text, sentences: segmentSentences(text) }],
      },
      (p) => {
        if (!ctx.setup) return;
        ctx.setup = { ...ctx.setup, label: p.phase === "download" && !isCacheLoad(p) ? "Downloading text models" : "Loading text models", message: p.message, loaded: p.loaded, total: p.total };
        render();
      },
    );
    // 2. The voice model, if the voice check is on.
    const voice = ctx.settings.voice;
    if (voice?.enabled) {
      ctx.setup = { label: "Downloading voice model", message: VOICE_MODELS[voice.model].label, loaded: 0, total: VOICE_MODELS[voice.model].bytes };
      render();
      const onVoice = (m: unknown) => {
        if (!isVoiceProgress(m) || !ctx.setup) return;
        ctx.setup = { ...ctx.setup, loaded: m.loaded, total: m.total };
        render();
      };
      browser.runtime.onMessage.addListener(onVoice);
      try {
        const res = (await browser.runtime.sendMessage({ kind: "lad-voice", op: "download", model: voice.model } satisfies VoiceRequest)) as VoiceResponse | undefined;
        if (res && !res.ok) throw new Error(res.error);
        ctx.voiceCached = { ...ctx.voiceCached, [voice.model]: true };
      } finally {
        browser.runtime.onMessage.removeListener(onVoice);
      }
    }
    ctx.setup = null;
    await refreshCache();
  } catch (err) {
    ctx.setup = { ...(ctx.setup ?? { label: "", loaded: 0, total: 0, message: "" }), error: err instanceof Error ? err.message : String(err) };
  } finally {
    ctx.checklistBusy = false;
    ctx.settings = await getSettings();
    render();
  }
}

// ---- Unsupported page ----

function renderUnsupported(): HTMLElement {
  const kind = ctx.unreadable ?? parseUnreadable(ctx.error) ?? classifyUrl(ctx.tabUrl) ?? "restricted";
  return h("div", { class: "popup-body" }, h("p", { class: "field-hint unreadable-line" }, unreadableMessage(kind)));
}

// ---- Progress ----

function progressLabelFor(progress: ProgressEvent): string {
  if (progress.phase === "analyze") return "Analyzing";
  if (progress.phase === "download" && !isCacheLoad(progress)) return "Downloading";
  return "Loading";
}

function renderProgress(): HTMLElement {
  const progress = ctx.progress!;
  const pct = progressPercent(progress);
  const cache = isCacheLoad(progress);
  return h(
    "div",
    { class: "popup-body" },
    h(
      "div",
      { class: "progress-panel" },
      h("div", { class: "phase" }, progressLabelFor(progress)),
      h(
        "div",
        { class: `progress-bar${pct === null ? " indeterminate" : ""}` },
        h("span", { style: `width:${pct ?? 40}%` }),
      ),
      h(
        "div",
        { class: "detail" },
        h("span", { class: "message", title: progress.message || "" }, progress.message || ""),
        h(
          "span",
          { class: "num" },
          // Bytes only while downloading; the analyze phase counts steps (chunks), shown as a percentage.
          pct === null || progress.total <= 0 || cache
            ? ""
            : progress.phase === "analyze"
              ? formatPercent(pct / 100)
              : `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`,
        ),
      ),
    ),
  );
}

// ---- Error (a compact inline prompt for consent-required; a plain retry otherwise) ----

function renderErrorView(): HTMLElement {
  if (ctx.error?.startsWith(CONSENT_REQUIRED_ERROR)) {
    return renderConsentChecklist();
  }
  return h(
    "div",
    { class: "popup-body" },
    h(
      "div",
      { class: "state-panel is-error" },
      warnIcon(),
      h("p", null, ctx.error ?? "Something went wrong."),
      h("button", { class: "btn btn-primary", type: "button", onclick: onRetry }, "Retry"),
    ),
  );
}

function onRetry(): void {
  ctx.error = null;
  render();
  if (ctx.lastTarget) void runAnalyze(ctx.lastTarget);
}

// ---- Main (idle / done) ----

/** True when the corner card has a result worth leading with. */
function cardHasResult(c: CardState | null): c is CardState {
  if (!c || c.off) return false;
  const v = c.video;
  return !!(c.article || c.thread || c.search || (v && (typeof v.transcript === "number" || typeof v.voice === "number" || v.voice === null || v.transcriptState)));
}

/** The page's current result as the corner card shows it: headline + one row per signal. */
function renderCardSection(c: CardState): HTMLElement {
  const summary = collapsedSummary(c);
  const head = h(
    "div",
    { class: "card-now" },
    ...summary.lines.map((l) => {
      const el = h("div", { class: "card-now-line mono" }, l.text);
      if (typeof l.score === "number") el.style.color = `hsl(${scoreHue(l.score).toFixed(0)}, 75%, 42%)`;
      return el;
    }),
  );
  const rows = h(
    "dl",
    { class: "card-now-rows" },
    ...hoverLines(c).flatMap((r) => [h("dt", null, r.label), h("dd", { class: r.dim ? "dim" : undefined }, r.value)]),
  );
  return h("div", { class: "result card-now-wrap" }, head, rows);
}

function renderMain(): HTMLElement {
  const body = h("div", { class: "popup-body" });
  // Video/thread/search pages, or any page the card has already checked while the
  // background forgot (its worker sleeps): lead with the card's own state.
  const useCard = cardHasResult(ctx.card) && (!ctx.result || ctx.card.pageType === "video" || ctx.card.pageType === "subtitles");
  body.append(useCard ? renderCardSection(ctx.card as CardState) : renderResultSection());
  const unreadable = ctx.unreadable ?? parseUnreadable(ctx.error) ?? (ctx.pageType ? null : classifyUrl(ctx.tabUrl));
  if (unreadable) {
    // A PDF's selected-text result: the page buttons can't work here.
    body.append(h("p", { class: "field-hint unreadable-line" }, unreadableMessage(unreadable)));
    return body;
  }
  const deepPrompt = renderDeepPrompt();
  if (deepPrompt) body.append(deepPrompt);
  body.append(renderButtons());
  // One disclosure: the result's breakdown, then mode/style, page type, site rule, paste.
  const more = h(
    "details",
    { class: "more-disclosure", open: ctx.moreOpen || ctx.pasteOpen || undefined, ontoggle: (e: Event) => (ctx.moreOpen = (e.target as HTMLDetailsElement).open) },
    h("summary", null, "Details"),
    ...(ctx.result && !useCard ? renderDetails(ctx.result) : []),
    renderQuickSelects(),
    renderPageTypeRow(),
    renderNeverOnSite(),
    renderPasteSection(),
  );
  body.append(more);
  return body;
}

const PAGE_OVERRIDE_LABEL: Record<PageTypeOverride, string> = {
  auto: "Auto",
  article: "Article",
  thread: "Thread",
  video: "Video",
  subtitles: "Subtitles",
  search: "Search",
  off: "Off",
};

/** "Page: video (YouTube)" plus this site's override -- quiet, one line. */
function renderPageTypeRow(): HTMLElement | null {
  if (!ctx.pageType) return null;
  // The content script's own hostname: the popup can't always see the tab's URL.
  const hostname = tabHostname() ?? ctx.pageType.host;
  if (!hostname) return h("div", { class: "page-type-row" }, h("span", { class: "field-hint" }, describeVerdict(ctx.pageType)));
  const current: PageTypeOverride = ctx.settings.pageTypes?.[hostname] ?? "auto";
  const select = h(
    "select",
    {
      class: "select-control select-small",
      "aria-label": `Page type on ${hostname}`,
      title: `Page type on ${hostname}`,
      onchange: (e: Event) => void setPageTypeOverride(hostname, (e.target as HTMLSelectElement).value as PageTypeOverride),
    },
    ...PAGE_TYPE_OVERRIDES.map((o) => h("option", { value: o, selected: o === current }, PAGE_OVERRIDE_LABEL[o])),
  );
  // Site memory: "This site: 3/10 AI" once a few pages here have been checked.
  const tally = ctx.settings.siteMemoryEnabled && ctx.siteTally && ctx.siteTally.total >= 2 ? ctx.siteTally : null;
  return h(
    "div",
    { class: "page-type-row" },
    h("span", { class: "field-hint" }, describeVerdict(ctx.pageType)),
    tally ? h("span", { class: "field-hint", title: `Last ${tally.total} pages checked on ${hostname}` }, `This site: ${tally.high}/${tally.total} AI`) : null,
    select,
  );
}

async function setPageTypeOverride(hostname: string, value: PageTypeOverride): Promise<void> {
  const pageTypes = { ...ctx.settings.pageTypes };
  if (value === "auto") delete pageTypes[hostname];
  else pageTypes[hostname] = value;
  ctx.settings = await setSettings({ pageTypes });
  if (ctx.tabId !== null) {
    ctx.pageType = (await sendTabMessage(ctx.tabId, "getPageType", undefined).catch(() => ctx.pageType)) as (PageVerdict & { host?: string }) | null;
  }
  render();
}

/** The verdict next to the "N% AI" number. */
const VERDICT_WORDS: Record<ReturnType<typeof bandFromResult>, string> = {
  human: "· likely human",
  mixed: "· mixed",
  ai: "· likely AI",
  insufficient: "· too short to judge",
};

function bandWord(result: AnalyzeResult | null): { band: ReturnType<typeof bandFromResult>; text: string; score: number | null } {
  if (!result) return { band: "insufficient", text: "—", score: null };
  const band = bandFromResult(result, ctx.settings);
  const score = displayScore(result);
  if (band === "insufficient" || score === null) return { band, text: "—", score: null };
  // The number is always P(AI): "44% AI", never read as "44% human".
  return { band, text: `${Math.round(score * 100)}% AI`, score };
}

function renderResultSection(): HTMLElement {
  const result = ctx.result;
  const { band, text, score } = bandWord(result);
  const valueEl = h("span", { class: `score-value mono ${bandClassName(band)}` }, result ? text : "—");
  if (score !== null) valueEl.style.color = `hsl(${scoreHue(score).toFixed(0)}, 75%, 42%)`;
  const verdictLabel = h("span", { class: `verdict-label ${bandClassName(band)}` }, result ? VERDICT_WORDS[band] : "Not checked yet");
  const wrap = h("div", { class: "score-line" }, valueEl, verdictLabel);
  const tier = tierTag(result);
  if (tier) wrap.append(tier);

  const container = h("div", { class: "result" }, wrap);
  return container;
}

/** Which pass the score is from: "Quick", "Deep check running…" (Quick shown meanwhile) or "Deep". */
function tierTag(result: AnalyzeResult | null): HTMLElement | null {
  if (!result?.tier) return null;
  const saved = result.cached ? " Remembered from an earlier check of this unchanged text." : "";
  if (isDeepResult(result)) return h("span", { class: "tier-tag is-deep", title: `All detectors, whole text.${saved}` }, result.cached ? "Deep · saved" : "Deep");
  const refining = result.refining || ctx.deepBusy;
  return h(
    "span",
    { class: `tier-tag${refining ? " is-refining" : ""}`, title: `Quick check: one small model, part of the page.${saved}` },
    refining ? "Deep check running…" : result.cached ? "Quick · saved" : "Quick",
  );
}

function renderDetails(result: AnalyzeResult): (Node | null)[] {
  const flagged = countFlaggedSentences(result.sentences);
  const sources = aggregateSources(result.sentences);
  const entries = Object.entries(sources) as [keyof typeof SOURCE_LABEL, number][];
  const rows: (Node | null)[] = [
    h("p", { class: "field-hint" }, DETAILS_NOTE),
    statRow("Flagged sentences", `${flagged} / ${result.sentences.length}`, flagged ? "warn" : undefined),
  ];
  if (result.words !== undefined) rows.push(statRow("Words analysed", String(result.words)));
  if (result.device) rows.push(statRow("Device", result.device.toUpperCase()));
  if (result.fusion) {
    const { agree, total, disagree } = result.fusion.agreement;
    rows.push(statRow("Detector agreement", `${agree}/${total}${disagree ? " (disagree)" : ""}`, disagree ? "warn" : undefined));
  }
  if (result.detectors?.length) {
    for (const d of result.detectors) {
      rows.push(statRow(`${d.label} (${d.device}/${d.dtype})`, formatPercent(d.overall)));
    }
  } else if (entries.length) {
    const list = h("div", { class: "breakdown-list" });
    for (const [source, value] of entries) {
      list.append(
        h(
          "div",
          { class: "breakdown-row" },
          h("span", { class: "label" }, SOURCE_LABEL[source]),
          h("span", { class: "bar" }, h("span", { style: `width:${Math.round(value * 100)}%` })),
          h("span", { class: "num" }, formatPercent(value)),
        ),
      );
    }
    rows.push(list);
  }
  const unicode = renderUnicodeRow(result);
  if (unicode) rows.push(unicode);
  // Pasted / dropped text has no page, so no images to report.
  if (!isPastedResult(result)) rows.push(renderImagesCard(result));
  return rows;
}

const PASTE_BLOCK_ID = "paste-1";

function isPastedResult(result: AnalyzeResult): boolean {
  return result.sentences.length > 0 && result.sentences.every((s) => s.blockId === PASTE_BLOCK_ID);
}

function statRow(label: string, value: string, tone?: "warn"): HTMLElement {
  return h("div", { class: "stat-row" }, h("span", null, label), h("span", { class: `num${tone ? " is-warn" : ""}` }, value));
}

function renderUnicodeRow(result: AnalyzeResult): HTMLElement | null {
  if (!ctx.settings.showUnicode) return null;
  const { totalSuspicious } = result.unicode;
  return statRow("Unusual characters", String(totalSuspicious), totalSuspicious ? "warn" : undefined);
}

function renderImagesCard(result: AnalyzeResult): HTMLElement {
  const images = result.images;
  if (!ctx.settings.checkImages || images?.disabled) return statRow("Images", "off");
  if (!images) return statRow("Images", "checking…");
  if (images.total === 0) return statRow("Images checked", "0");
  const parts: HTMLElement[] = [statRow("Images checked", `${images.checked} / ${images.total}`)];
  if (images.withCredentials > 0) {
    parts.push(
      statRow("Content Credentials", images.trustedCredentials > 0 ? `${images.withCredentials} (${images.trustedCredentials} trusted)` : String(images.withCredentials)),
    );
  }
  if (images.aiSignals > 0) parts.push(statRow("With an AI signal", String(images.aiSignals), "warn"));
  if (images.withUnsignedClaim > 0) parts.push(statRow("Unsigned AI claim", String(images.withUnsignedClaim)));
  if (images.withWatermark > 0) parts.push(statRow("Watermark hit", String(images.withWatermark), "warn"));
  const grant =
    images.permissionNeeded.length > 0
      ? h(
          "button",
          { class: "btn btn-block btn-small", type: "button", onclick: () => void grantImageAccess(images.permissionNeeded) },
          `Allow images on ${images.permissionNeeded.length === 1 ? hostOf(images.permissionNeeded[0]!) : `${images.permissionNeeded.length} sites`}`,
        )
      : null;
  const wrap = h("div", null, ...parts);
  if (grant) wrap.append(grant);
  return wrap;
}

function hostOf(pattern: string): string {
  return pattern.replace(/^[a-z]+:\/\//, "").replace(/\/\*$/, "");
}

async function grantImageAccess(patterns: string[]): Promise<void> {
  const granted = await requestImagePermission(patterns);
  if (!granted || ctx.tabId === null) return;
  try {
    const images = await sendTabMessage(ctx.tabId, "scanImages", undefined);
    if (ctx.result) ctx.result = { ...ctx.result, images };
    render();
  } catch {
    // The status event from the background will refresh us anyway.
  }
}

function renderButtons(): HTMLElement {
  const selectionDimmed = ctx.hasSelection === false;
  const known = !!ctx.result || cardHasResult(ctx.card);
  const label = !known ? "Check page" : isDeepResult(ctx.result) ? "Check again" : "Deep check";
  // While the Deep pass runs (the Quick result on show), the primary button stops it.
  const refiningNow = (ctx.deepBusy && !!ctx.result) || !!ctx.result?.refining;
  const buttons = [
    refiningNow
      ? h("button", { class: "btn btn-cancel", type: "button", title: "Stop the Deep check and keep the Quick result", onclick: () => void onCancelDeep() }, "Cancel deep check")
      : h(
          "button",
          { class: "btn btn-primary", type: "button", title: DEEP_CHECK_TOOLTIP, disabled: ctx.deepBusy || undefined, onclick: () => void onManualCheck("page") },
          ctx.deepBusy ? "Checking…" : label,
        ),
    h(
      "button",
      {
        class: "btn",
        type: "button",
        "aria-disabled": selectionDimmed ? "true" : undefined,
        title: selectionDimmed ? "Select text first" : undefined,
        onclick: () => void onSelectionClick(),
      },
      "Selection",
    ),
  ];
  if (offerShowOnPage(ctx.settings)) {
    buttons.push(h("button", { class: "btn", type: "button", onclick: () => void showOnPage() }, "Show on page"));
  }
  buttons.push(
    h(
      "button",
      { class: "btn btn-icon-text", type: "button", title: "Clear", onclick: () => void clearHighlights() },
      closeIcon(),
    ),
  );
  return h("div", { class: "btn-row" }, ...buttons);
}

function renderNeverOnSite(): HTMLElement | null {
  const hostname = tabHostname();
  if (!hostname) return null;
  const never = ctx.settings.siteRules[hostname] === "never";
  return h(
    "button",
    {
      class: "btn btn-ghost btn-small",
      type: "button",
      title: never ? `Auto-run is off on ${hostname}` : `Turn off auto-run on ${hostname}`,
      onclick: () => void toggleNeverOnSite(hostname, never),
    },
    never ? `Auto-run off on ${hostname} ✓` : `Never auto-run on ${hostname}`,
  );
}

function tabHostname(): string | null {
  if (!ctx.tabUrl) return null;
  try {
    return new URL(ctx.tabUrl).hostname || null;
  } catch {
    return null;
  }
}

async function toggleNeverOnSite(hostname: string, currentlyNever: boolean): Promise<void> {
  const siteRules = { ...ctx.settings.siteRules };
  if (currentlyNever) delete siteRules[hostname];
  else siteRules[hostname] = "never";
  ctx.settings = await setSettings({ siteRules });
  render();
}

async function showOnPage(): Promise<void> {
  if (ctx.tabId === null) return;
  try {
    await sendTabMessage(ctx.tabId, "showOnPage", undefined);
  } catch {
    // ignore -- the content script may not be injected yet on this tab.
  }
}

// ---- Paste text + file drop ----

function renderPasteSection(): HTMLElement {
  const toggle = h(
    "button",
    { class: "btn btn-ghost btn-block btn-small", type: "button", onclick: () => togglePaste() },
    ctx.pasteOpen ? "Paste text ▲" : "Paste text ▼",
  );
  if (!ctx.pasteOpen) return h("div", null, toggle);

  const textarea = h("textarea", {
    class: "paste-textarea",
    rows: "4",
    placeholder: "Paste text to check…",
  }) as HTMLTextAreaElement;

  const fileInput = h("input", {
    type: "file",
    accept: ACCEPTED_FILE_EXTENSIONS,
    class: "sr-only-file",
    onchange: (e: Event) => void onFileChosen((e.target as HTMLInputElement).files?.[0]),
  }) as HTMLInputElement;

  const dropzone = h(
    "div",
    {
      class: "dropzone",
      onclick: () => fileInput.click(),
      ondragover: (e: DragEvent) => e.preventDefault(),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        void onFileChosen(e.dataTransfer?.files?.[0]);
      },
    },
    `Drop a ${ACCEPTED_FILE_EXTENSIONS.replaceAll(",", " / ")} file, or click to choose`,
    fileInput,
  );

  const rows: (Node | null)[] = [
    toggle,
    textarea,
    h(
      "button",
      {
        class: "btn btn-primary btn-block btn-small",
        type: "button",
        disabled: ctx.pasteBusy,
        onclick: () => void analyzePastedText(textarea.value),
      },
      "Analyze text",
    ),
    dropzone,
  ];
  if (ctx.pasteError) rows.push(h("p", { class: "model-error-note" }, ctx.pasteError));
  return h("div", { class: "paste-panel" }, ...rows);
}

function togglePaste(): void {
  ctx.pasteOpen = !ctx.pasteOpen;
  render();
}

async function analyzePastedText(text: string): Promise<void> {
  if (!text.trim()) return;
  await analyzeArbitraryText(text);
}

async function onFileChosen(file: File | undefined): Promise<void> {
  if (!file) return;
  ctx.pasteBusy = true;
  ctx.pasteError = null;
  render();
  try {
    const text = await extractTextFromFile(file);
    await analyzeArbitraryText(text);
  } catch (err) {
    ctx.pasteError = err instanceof Error ? err.message : String(err);
  } finally {
    ctx.pasteBusy = false;
    render();
  }
}

/** Paste/file text is never on a page: no tabId, no highlight rendering -- just a scored result. */
async function analyzeArbitraryText(text: string): Promise<void> {
  ctx.pasteBusy = true;
  ctx.pasteError = null;
  ctx.error = null;
  ctx.progress = { phase: "analyze", loaded: 0, total: 0, message: "Analyzing…" };
  render();
  try {
    const sentences = segmentSentences(text);
    const blocks = [{ id: PASTE_BLOCK_ID, text, sentences }];
    const result = await sendMessage("analyze", { tabId: -1, mode: ctx.settings.mode, blocks });
    // The paste box wants NBSP counted as unusual (plain pasted text commonly
    // carries stray NBSPs from copy-paste); the page scan deliberately
    // doesn't. Computed client-side so the engine's shared scan is untouched.
    const unicode = scanUnicode(text, { includeNbsp: true });
    ctx.result = { ...result, unicode };
    ctx.progress = null;
    ctx.pasteOpen = false;
  } catch (err) {
    ctx.pasteError = err instanceof Error ? err.message : String(err);
    ctx.progress = null;
  } finally {
    ctx.pasteBusy = false;
    render();
  }
}

function renderQuickSelects(): HTMLElement {
  const modeSelect = h(
    "select",
    {
      "aria-label": "Detector mode",
      onchange: (e: Event) => void onModeChange((e.target as HTMLSelectElement).value as Mode),
    },
    ...(Object.keys(MODE_LABEL) as Mode[]).map((mode) => {
      const status = modeDownloadStatus(mode, ctx.settings.fusion, ctx.settings.modelOverrides, "wasm", ctx.cache);
      const hint = status.cached ? "" : status.missingBytes !== null ? ` — download (${Math.round(status.missingBytes / 1e6)} MB)` : " — not downloaded";
      return h(
        "option",
        { value: mode, selected: ctx.settings.mode === mode, style: hint ? "color: var(--ink-faint)" : undefined },
        MODE_LABEL[mode] + (EXPERIMENTAL_MODES.has(mode) ? " (experimental)" : "") + hint,
      );
    }),
  );
  const styleSelect = h(
    "select",
    {
      "aria-label": "Highlight style",
      onchange: (e: Event) => void onStyleChange((e.target as HTMLSelectElement).value as HighlightStyle),
    },
    h("option", { value: "heatmap", selected: ctx.settings.highlightStyle === "heatmap" }, "Heatmap"),
    h("option", { value: "flagged", selected: ctx.settings.highlightStyle === "flagged" }, "Flagged only"),
    h("option", { value: "underline", selected: ctx.settings.highlightStyle === "underline" }, "Underline"),
  );
  return h(
    "div",
    { class: "quick-selects" },
    h("div", { class: "field" }, h("span", { class: "field-hint" }, "Mode"), modeSelect),
    h("div", { class: "field" }, h("span", { class: "field-hint" }, "Style"), styleSelect),
  );
}

async function onModeChange(mode: Mode): Promise<void> {
  ctx.settings = await setSettings({ mode });
  render();
}

async function onStyleChange(highlightStyle: HighlightStyle): Promise<void> {
  ctx.settings = await setSettings({ highlightStyle });
}

// ---- Actions ----

async function onSelectionClick(): Promise<void> {
  if (ctx.hasSelection === false) {
    showToast(NO_SELECTION_ERROR);
    return; // leave the popup state untouched -- this isn't an error.
  }
  await onManualCheck("selection");
}

/**
 * A check the user asked for: Quick first (shown as soon as it lands, tagged
 * "deep check running"), then Deep over the top (router.runManualCheck). If
 * the Deep models aren't downloaded and a Quick result is already on show,
 * this is the Deep button: offer the download.
 */
async function onManualCheck(target: "page" | "selection"): Promise<void> {
  if (target === "page" && ctx.result && !isDeepResult(ctx.result) && !deepDownloadStatus(ctx.settings, "wasm", ctx.cache).cached) {
    return onDeepCheck();
  }
  // "Check again" on a Deep result: a fresh run, not the remembered one.
  await runAnalyze(target, true, target === "page" && isDeepResult(ctx.result));
}

async function onCancelDeep(): Promise<void> {
  if (ctx.tabId === null) return;
  await sendMessage("cancelAnalysis", { tabId: ctx.tabId }).catch(() => {});
}

async function runAnalyze(target: "page" | "selection", manual = false, fresh = false): Promise<void> {
  const tabId = ctx.tabId;
  if (tabId === null) {
    ctx.error = "No active tab.";
    render();
    return;
  }
  const previous = { lastTarget: ctx.lastTarget, result: ctx.result };
  ctx.lastTarget = target;
  ctx.error = null;
  // Page re-check: keep the current result on show; it's refined in place.
  const keep = manual && target === "page" && !!ctx.result;
  if (!keep) ctx.result = null;
  ctx.deepBusy = manual;
  ctx.progress = keep ? null : { phase: "download", loaded: 0, total: 0, message: "Starting…" };
  render();
  try {
    const result = await sendMessage("analyzeTab", { tabId, target, manual, fresh }, (progress) => {
      // Once a (Quick) result is on show, the Deep pass's progress stays out of the way.
      if (ctx.result) return;
      ctx.progress = progress;
      render();
    });
    ctx.progress = null;
    const seen = ctx.result as AnalyzeResult | null;
    ctx.result = { ...result, images: seen?.images ?? result.images };
    ctx.deepBusy = false;
    render();
  } catch (err) {
    ctx.progress = null;
    ctx.deepBusy = false;
    if (err instanceof Error && err.message === CANCELLED_ERROR) {
      // Back to the Quick result (the background re-broadcasts it too).
      if (ctx.result) ctx.result = { ...ctx.result, refining: false };
      render();
      showToast("Deep check cancelled");
      return;
    }
    if (err instanceof Error && err.message === NO_SELECTION_ERROR) {
      // Expected, not an error: put the popup back as it was and toast.
      Object.assign(ctx, previous);
      render();
      showToast(NO_SELECTION_ERROR);
      return;
    }
    ctx.error = describeAnalyzeError(err);
    render();
  }
}

// ---- Deep check (docs/plan.md "Two tiers: Quick (default) and Deep (on demand)") ----

/** First click: if the deep detector set isn't fully downloaded, show the inline prompt instead of running. */
async function onDeepCheck(): Promise<void> {
  const tabId = ctx.tabId;
  if (tabId === null) return;
  if (!ctx.deepChecklistOpen) {
    const status = deepDownloadStatus(ctx.settings, "wasm", ctx.cache);
    if (!status.cached) {
      ctx.deepChecklistOpen = true;
      render();
      return;
    }
  }
  ctx.deepChecklistOpen = false;
  ctx.deepBusy = true;
  ctx.error = null;
  render();
  try {
    const target = ctx.lastTarget ?? "page";
    const result = await sendMessage(
      "analyzeTab",
      { tabId, target, ...deepCheckRequestFields(ctx.settings) },
      (progress) => {
        ctx.progress = progress;
        render();
      },
    );
    ctx.lastTarget = target;
    ctx.progress = null;
    const seen = ctx.result as AnalyzeResult | null;
    ctx.result = { ...result, images: seen?.images ?? result.images };
  } catch (err) {
    ctx.progress = null;
    ctx.error = describeAnalyzeError(err);
  } finally {
    ctx.deepBusy = false;
    render();
  }
}

function renderDeepPrompt(): HTMLElement | null {
  if (!ctx.deepChecklistOpen) return null;
  const status = deepDownloadStatus(ctx.settings, "wasm", ctx.cache);
  const mb = status.missingBytes !== null ? `${Math.round(status.missingBytes / 1e6)} MB` : "an unknown amount";
  return h(
    "div",
    { class: "deep-prompt" },
    h("p", { class: "field-hint" }, `Deep check needs to download ${mb} of models.`),
    h(
      "div",
      { class: "btn-row" },
      h("button", { class: "btn btn-primary btn-small", type: "button", onclick: () => void onDeepCheck() }, `Download & run (${mb})`),
      h(
        "button",
        {
          class: "btn btn-ghost btn-small",
          type: "button",
          onclick: () => {
            ctx.deepChecklistOpen = false;
            render();
          },
        },
        "Cancel",
      ),
    ),
  );
}

function describeAnalyzeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith(CONSENT_REQUIRED_ERROR)) return message;
  return message;
}

async function clearHighlights(): Promise<void> {
  const tabId = ctx.tabId;
  if (tabId === null) return;
  try {
    await sendTabMessage(tabId, "clearHighlights", undefined);
  } catch {
    // No content script listening yet -- nothing to clear.
  }
}

void main();
