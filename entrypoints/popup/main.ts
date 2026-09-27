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

import "../../src/ui/styles.css";
import "./popup.css";

import { browser } from "wxt/browser";
import { getSettings, setSettings, watchSettings } from "@/src/shared/settings";
import type { HighlightStyle, Mode, Settings } from "@/src/shared/settings";
import { CONSENT_REQUIRED_ERROR, onAnalysisStatus, sendMessage, sendTabMessage } from "@/src/shared/messages";
import type { AnalyzeResult, ProgressEvent, TabAnalysisStatus } from "@/src/shared/messages";
import { clearChildren, h } from "@/src/ui/dom";
import { derivePopupState, isCacheLoad, isUnsupportedUrl, progressPercent } from "@/src/ui/state";
import type { PopupState } from "@/src/ui/state";
import { BAND_LABEL, bandClassName, bandFromResult, DETAILS_NOTE } from "@/src/ui/verdict";
import { displayScore, formatScoreOrDash } from "@/src/ui/probability";
import { buildGaugeSvg, updateGauge } from "@/src/ui/gauge";
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
import { checklistRows, modeDownloadStatus, renderModelChecklist, type CacheKnown } from "@/src/ui/modelChecklist";
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
  pasteBusy: false,
  pasteError: null,
  hasSelection: null,
  cache: undefined,
  checklistBusy: false,
  deepBusy: false,
  deepChecklistOpen: false,
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

async function refreshCache(): Promise<void> {
  try {
    const info = await sendMessage("getModelCacheInfo", undefined);
    const known: CacheKnown = {};
    for (const [slot, entry] of Object.entries(info.slots) as [ModelSlot, { cached: boolean }][]) {
      known[slot] = entry.cached;
    }
    ctx.cache = known;
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
  });
}

function render(): void {
  clearChildren(root);
  const state = currentState();
  root.append(renderHeader());
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
      root.append(renderFooter());
      break;
    case "error":
      root.append(renderErrorView());
      root.append(renderFooter());
      break;
    case "idle":
    case "done":
      root.append(renderMain());
      root.append(renderFooter());
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
      { class: "icon-btn", type: "button", "aria-label": "Settings", title: "Settings", onclick: openOptions },
      gearIcon(),
    ),
  );
}

function renderFooter(): HTMLElement {
  return h(
    "footer",
    { class: "popup-footer" },
    h("span", null, "Runs on this device."),
    h(
      "button",
      {
        class: `icon-btn${ctx.deepBusy ? " is-spinning" : ""}`,
        type: "button",
        "aria-label": "Deep check",
        title: DEEP_CHECK_TOOLTIP,
        disabled: ctx.deepBusy || ctx.tabId === null,
        onclick: () => void onDeepCheck(),
      },
      "↻",
    ),
    h("button", { class: "btn btn-ghost", type: "button", onclick: openOptions }, "Settings"),
  );
}

function openOptions(): void {
  void browser.runtime.openOptionsPage();
}

// ---- Consent (model download checklist; no paragraphs) ----

/** First-run checklist: every model the selected mode needs, ticked by default, sizes + roles + a running total. */
function renderConsentChecklist(): HTMLElement {
  const rows = checklistRows(ctx.settings.mode, ctx.settings.fusion, ctx.settings.modelOverrides, "wasm", ctx.cache);
  return h(
    "div",
    { class: "popup-body consent" },
    h("p", { class: "field-hint" }, `${MODE_LABEL[ctx.settings.mode]} needs:`),
    renderModelChecklist({
      rows,
      onToggle: (id, checked) => void onConsentToggle(id, checked),
      onDownload: () => void onConsent(),
      downloadLabel: "Download & enable",
      busy: ctx.checklistBusy,
    }),
  );
}

function renderConsent(): HTMLElement {
  return renderConsentChecklist();
}

async function onConsentToggle(id: FusionDetector, checked: boolean): Promise<void> {
  const current = ctx.settings.fusion.detectors;
  const next = checked ? [...new Set([...current, id])] : current.filter((d) => d !== id);
  if (next.length === 0) return; // keep at least one
  ctx.settings = await setSettings({ fusion: sanitizeFusion({ ...ctx.settings.fusion, detectors: next }) });
  render();
}

async function onConsent(): Promise<void> {
  ctx.settings = await setSettings({ consentedDownload: true });
  render();
}

// ---- Unsupported page ----

function renderUnsupported(): HTMLElement {
  return h(
    "div",
    { class: "popup-body" },
    h("div", { class: "state-panel" }, warnIcon(), h("p", null, "Can't read this page.")),
  );
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
          pct !== null && progress.total > 0 && !cache ? `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}` : "",
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

function renderMain(): HTMLElement {
  const body = h("div", { class: "popup-body" });
  body.append(renderResultSection());
  const deepPrompt = renderDeepPrompt();
  if (deepPrompt) body.append(deepPrompt);
  body.append(renderButtons());
  body.append(renderPasteSection());
  body.append(renderQuickSelects());
  return body;
}

function bandWord(result: AnalyzeResult | null): { band: ReturnType<typeof bandFromResult>; text: string; score: number | null } {
  if (!result) return { band: "insufficient", text: "—", score: null };
  const band = bandFromResult(result, ctx.settings);
  const score = displayScore(result);
  if (band === "insufficient" || score === null) return { band, text: "—", score: null };
  return { band, text: `${Math.round(score * 100)}%`, score };
}

function renderResultSection(): HTMLElement {
  const result = ctx.result;
  const { band, text, score } = bandWord(result);
  const wrap = h("div", { class: "gauge-wrap" });
  const figure = h("div", { class: "gauge-figure" });
  const svg = buildGaugeSvg();
  figure.append(svg);
  const valueEl = h("div", { class: `value mono ${bandClassName(band)}` }, result ? text : "—");
  if (score !== null) valueEl.style.color = `hsl(${scoreHue(score).toFixed(0)}, 75%, 42%)`;
  const readout = h("div", { class: "gauge-readout" }, valueEl);
  figure.append(readout);
  wrap.append(figure);
  const verdictLabel = h("div", { class: `verdict-label ${bandClassName(band)}` }, result ? BAND_LABEL[band] : "No result");
  if (isDeepResult(result)) verdictLabel.append(h("span", { class: "deep-tag" }, "Deep"));
  wrap.append(verdictLabel);
  queueMicrotask(() => updateGauge(svg, score ?? 0, bandClassName(band)));

  const container = h("div", { class: "result" }, wrap);
  if (result) container.append(renderDetails(result));
  return container;
}

function renderDetails(result: AnalyzeResult): HTMLElement {
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
  rows.push(renderImagesCard(result));
  return h("details", { class: "details-disclosure" }, h("summary", null, "Details"), ...rows);
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
  const buttons = [
    h("button", { class: "btn btn-primary", type: "button", onclick: () => void runAnalyze("page") }, "Analyze page"),
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
  if (ctx.settings.presence === "onClick") {
    buttons.push(h("button", { class: "btn", type: "button", onclick: () => void showOnPage() }, "Show on page"));
  }
  buttons.push(
    h(
      "button",
      { class: "btn btn-icon-text", type: "button", title: "Clear", onclick: () => void clearHighlights() },
      closeIcon(),
    ),
  );
  const row = h("div", { class: "btn-row" }, ...buttons);
  const hostname = tabHostname();
  if (hostname) {
    const never = ctx.settings.siteRules[hostname] === "never";
    row.append(
      h(
        "button",
        {
          class: "btn btn-ghost btn-small",
          type: "button",
          title: never ? `Auto-run is off on ${hostname}` : `Turn off auto-run on ${hostname}`,
          onclick: () => void toggleNeverOnSite(hostname, never),
        },
        never ? "Off here ✓" : "Never on this site",
      ),
    );
  }
  return row;
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
    const blocks = [{ id: "paste-1", text, sentences }];
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
    showToast("No text selected");
    return; // leave the popup state untouched -- this isn't an error.
  }
  await runAnalyze("selection");
}

async function runAnalyze(target: "page" | "selection"): Promise<void> {
  const tabId = ctx.tabId;
  if (tabId === null) {
    ctx.error = "No active tab.";
    render();
    return;
  }
  ctx.lastTarget = target;
  ctx.error = null;
  ctx.result = null;
  ctx.progress = { phase: "download", loaded: 0, total: 0, message: "Starting…" };
  render();
  try {
    const result = await sendMessage("analyzeTab", { tabId, target }, (progress) => {
      ctx.progress = progress;
      render();
    });
    ctx.progress = null;
    const seen = ctx.result as AnalyzeResult | null;
    ctx.result = { ...result, images: seen?.images ?? result.images };
    render();
  } catch (err) {
    ctx.progress = null;
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
