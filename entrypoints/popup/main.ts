// Popup: consent screen, main gauge/results view, download/analysis
// progress, error/unsupported states. See src/ui/** for the pure logic this
// leans on (state machine, verdict wording, gauge geometry, formatting) and
// src/shared/{messages,settings}.ts for the background/content-script
// contract.

import "../../src/ui/styles.css";
import "./popup.css";

import { browser } from "wxt/browser";
import { getSettings, setSettings, watchSettings } from "@/src/shared/settings";
import type { HighlightStyle, Mode, Settings } from "@/src/shared/settings";
import { CONSENT_REQUIRED_ERROR, onAnalysisStatus, sendMessage, sendTabMessage } from "@/src/shared/messages";
import type { AnalyzeResult, ProgressEvent, TabAnalysisStatus } from "@/src/shared/messages";
import { clearChildren, h } from "@/src/ui/dom";
import { derivePopupState, isUnsupportedUrl, progressLabel, progressPercent } from "@/src/ui/state";
import type { PopupState } from "@/src/ui/state";
import { BAND_DESCRIPTION, BAND_LABEL, bandClassName, bandFromResult } from "@/src/ui/verdict";
import { buildGaugeSvg, updateGauge } from "@/src/ui/gauge";
import { formatBytes, formatPercent, pluralize } from "@/src/ui/format";
import { aggregateSources, countFlaggedSentences, SOURCE_LABEL } from "@/src/ui/breakdown";
import { EXPERIMENTAL_MODES, MODE_LABEL, modeSizeMB } from "@/src/ui/modelInfo";
import { brandMark, closeIcon, gearIcon, warnIcon } from "@/src/ui/icons";
import { requestImagePermission } from "@/src/provenance/permissions";

interface Ctx {
  settings: Settings;
  tabId: number | null;
  tabUrl: string | null;
  progress: ProgressEvent | null;
  result: AnalyzeResult | null;
  error: string | null;
  lastTarget: "page" | "selection" | null;
}

const ctx: Ctx = {
  settings: await getSettings(),
  tabId: null,
  tabUrl: null,
  progress: null,
  result: null,
  error: null,
  lastTarget: null,
};

const root = document.getElementById("app") as HTMLDivElement;

async function main() {
  const tab = await targetTab();
  ctx.tabId = tab?.id ?? null;
  ctx.tabUrl = tab?.url ?? null;
  render();

  // Resync with whatever the background already knows about this tab (e.g.
  // an autoRun analysis kicked off before the popup was opened), then follow
  // further changes live — including analyses this popup didn't start.
  if (ctx.tabId !== null) {
    const tabId = ctx.tabId;
    sendMessage("getTabStatus", { tabId })
      .then((status) => {
        applyStatus(status);
        render();
      })
      .catch(() => {
        // Not implemented yet, or no background listener — stay idle.
      });
    onAnalysisStatus((eventTabId, status) => {
      if (eventTabId !== tabId) return;
      applyStatus(status);
      render();
    });
  }

  watchSettings((settings) => {
    ctx.settings = settings;
    render();
  });
}

/**
 * The tab this popup acts on: the active tab, or `?tabId=N` when the popup
 * page is opened as a normal tab (used by the E2E suite in scripts/e2e/).
 */
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

/** Maps the background's per-tab status (which can change from outside this
 * popup, e.g. autoRun) onto the local ctx fields the render functions read. */
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
    tabUrl: ctx.tabUrl,
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
      { class: "icon-btn", type: "button", "aria-label": "Open settings", title: "Settings", onclick: openOptions },
      gearIcon(),
    ),
  );
}

function renderFooter(): HTMLElement {
  return h(
    "footer",
    { class: "popup-footer" },
    h("span", null, "Everything above runs on this device."),
    h("button", { class: "btn btn-ghost", type: "button", onclick: openOptions }, "Settings"),
  );
}

function openOptions(): void {
  void browser.runtime.openOptionsPage();
}

// ---- Consent ----

function renderConsent(): HTMLElement {
  const size = modeSizeMB(ctx.settings.mode);
  return h(
    "div",
    { class: "popup-body consent" },
    h(
      "p",
      null,
      "This detector runs entirely on your device. To score text it needs to download a small AI model once, from Hugging Face — after that, nothing about a page you analyze leaves your browser.",
    ),
    h(
      "div",
      { class: "consent-size panel" },
      h("span", null, `One-time download (${MODE_LABEL[ctx.settings.mode]} mode)`),
      h("span", { class: "value mono" }, `~${size} MB`),
    ),
    h(
      "ul",
      null,
      h("li", null, "Works fully offline afterwards — no accounts, no analytics, no page contents sent anywhere."),
      h(
        "li",
        null,
        "No detector, including this one, is reliable enough to accuse anyone of anything. Treat every score as a hint, not proof — see the accuracy notes in Settings → About.",
      ),
      h("li", null, "English text works best. Short passages (under ~50 words) are too noisy to score meaningfully."),
    ),
    h(
      "button",
      { class: "btn btn-primary btn-block", type: "button", onclick: onConsent },
      "Download & enable",
    ),
  );
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
    h(
      "div",
      { class: "state-panel" },
      warnIcon(),
      h("p", null, "This page can't be scanned."),
      h(
        "p",
        { class: "field-hint" },
        "Browser pages, extension or store listings, and PDF viewers don't allow a content script to read the page.",
      ),
    ),
  );
}

// ---- Progress ----

function renderProgress(): HTMLElement {
  const progress = ctx.progress!;
  const pct = progressPercent(progress);
  return h(
    "div",
    { class: "popup-body" },
    h(
      "div",
      { class: "progress-panel" },
      h("div", { class: "phase" }, progressLabel(progress)),
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
          pct !== null && progress.total > 0
            ? `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
            : "",
        ),
      ),
    ),
  );
}

// ---- Error ----

function renderErrorView(): HTMLElement {
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
  body.append(renderButtons());
  body.append(renderQuickSelects());
  return body;
}

function renderResultSection(): HTMLElement {
  const result = ctx.result;
  const wrap = h("div", { class: "gauge-wrap" });
  const figure = h("div", { class: "gauge-figure" });
  const svg = buildGaugeSvg();
  const band = result ? bandFromResult(result, ctx.settings) : "insufficient";
  figure.append(svg);
  const readout = h(
    "div",
    { class: "gauge-readout" },
    h(
      "div",
      { class: `value mono ${bandClassName(band)}` },
      result && band !== "insufficient" ? formatPercent(result.overall) : "—",
    ),
  );
  figure.append(readout);
  wrap.append(figure);
  wrap.append(h("div", { class: `verdict-label ${bandClassName(band)}` }, result ? BAND_LABEL[band] : "No analysis yet"));
  wrap.append(
    h(
      "div",
      { class: "verdict-desc" },
      result ? BAND_DESCRIPTION[band] : "Click “Analyze page” to score the visible text on this tab.",
    ),
  );
  // Animate in after the element is attached; matches the score, respects
  // prefers-reduced-motion via the CSS transition itself.
  queueMicrotask(() => updateGauge(svg, result ? result.overall : 0, bandClassName(band)));

  const container = h("div", null, wrap);
  if (result) container.append(renderStats(result), renderBreakdown(result), renderUnicodeSummary(result), renderProvenanceSummary(result));
  return container;
}

function renderStats(result: AnalyzeResult): HTMLElement {
  const flagged = countFlaggedSentences(result.sentences);
  return h(
    "div",
    { class: "stat-row" },
    h("span", null, "Flagged sentences"),
    h("span", { class: "num" }, `${flagged} / ${result.sentences.length}`),
  );
}

function renderBreakdown(result: AnalyzeResult): HTMLElement {
  const sources = aggregateSources(result.sentences);
  const entries = Object.entries(sources) as [keyof typeof SOURCE_LABEL, number][];
  const list = h(
    "div",
    { class: "breakdown-list" },
    entries.length === 0 ? h("p", { class: "field-hint" }, "No per-detector scores were reported.") : null,
  );
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
  return h("div", null, h("div", { class: "section-title" }, "Per-detector breakdown"), list);
}

function renderUnicodeSummary(result: AnalyzeResult): HTMLElement {
  if (!ctx.settings.showUnicode) return h("div");
  const { totalSuspicious } = result.unicode;
  return h(
    "div",
    null,
    h(
      "div",
      { class: "stat-row" },
      h("span", null, "Unusual characters"),
      h("span", { class: "num" }, String(totalSuspicious)),
    ),
    totalSuspicious > 0
      ? h(
          "p",
          { class: "field-hint" },
          `${pluralize(totalSuspicious, "unusual character")} found — not evidence of AI on its own.`,
        )
      : null,
  );
}

function renderProvenanceSummary(result: AnalyzeResult): HTMLElement {
  const images = result.images;
  if (!ctx.settings.checkImages || images?.disabled) {
    return h("div", { class: "field-hint" }, "Images: provenance checks are off (Settings).");
  }
  if (!images) return h("div", { class: "field-hint" }, "Images: checking…");
  if (images.total === 0) return h("div", { class: "field-hint" }, "Images: none large enough to check on this page.");
  const parts = [`${images.checked} of ${pluralize(images.total, "image")} checked`];
  if (images.withCredentials > 0) {
    parts.push(
      `${images.withCredentials} with Content Credentials` +
        (images.trustedCredentials > 0 ? ` (${images.trustedCredentials} from a trusted signer)` : ""),
    );
  }
  if (images.aiSignals > 0) parts.push(`${images.aiSignals} with an AI signal`);
  if (images.withUnsignedClaim > 0) parts.push(`${images.withUnsignedClaim} with an unsigned AI-generator claim`);
  if (images.withWatermark > 0) parts.push(`${images.withWatermark} with an open-source watermark`);
  if (images.checked > 0 && images.aiSignals === 0) parts.push("no AI signals found (that doesn't mean human-made)");
  const wrap = h("div", { class: "field-hint" }, `Images: ${parts.join(" · ")}.`);
  if (images.permissionNeeded.length > 0) {
    wrap.append(
      h("br"),
      h(
        "button",
        { class: "btn btn-ghost", type: "button", onclick: () => void grantImageAccess(images.permissionNeeded) },
        `Allow image checks on ${images.permissionNeeded.length === 1 ? hostOf(images.permissionNeeded[0]!) : `${images.permissionNeeded.length} sites`}`,
      ),
    );
  }
  return wrap;
}

function hostOf(pattern: string): string {
  return pattern.replace(/^[a-z]+:\/\//, "").replace(/\/\*$/, "");
}

/** Must run from the click handler: permission requests need a user gesture. */
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
  return h(
    "div",
    { class: "btn-row" },
    h("button", { class: "btn btn-primary", type: "button", onclick: () => void runAnalyze("page") }, "Analyze page"),
    h(
      "button",
      { class: "btn", type: "button", onclick: () => void runAnalyze("selection") },
      "Analyze selection",
    ),
    h("button", { class: "btn btn-ghost", type: "button", onclick: () => void clearHighlights() }, closeIcon(), " Clear"),
  );
}

function renderQuickSelects(): HTMLElement {
  const modeSelect = h(
    "select",
    {
      "aria-label": "Detector mode",
      onchange: (e: Event) => void onModeChange((e.target as HTMLSelectElement).value as Mode),
    },
    ...(Object.keys(MODE_LABEL) as Mode[]).map((mode) =>
      h(
        "option",
        { value: mode, selected: ctx.settings.mode === mode },
        MODE_LABEL[mode] + (EXPERIMENTAL_MODES.has(mode) ? " (experimental)" : ""),
      ),
    ),
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
    h("div", { class: "field" }, h("span", { class: "field-hint" }, "Detector mode"), modeSelect),
    h("div", { class: "field" }, h("span", { class: "field-hint" }, "Highlight style"), styleSelect),
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

async function runAnalyze(target: "page" | "selection"): Promise<void> {
  const tabId = ctx.tabId;
  if (tabId === null) {
    ctx.error = "No active tab to analyze.";
    render();
    return;
  }
  ctx.lastTarget = target;
  ctx.error = null;
  ctx.result = null;
  ctx.progress = { phase: "download", loaded: 0, total: 0, message: "Starting…" };
  render();
  try {
    // One path for every entry point: the background extracts, analyzes and
    // renders highlights in the tab (see runTabAnalysis in src/engine/router.ts).
    const result = await sendMessage("analyzeTab", { tabId, target }, (progress) => {
      ctx.progress = progress;
      render();
    });
    ctx.progress = null;
    const seen = ctx.result as AnalyzeResult | null; // may have been updated by a status event meanwhile
    ctx.result = { ...result, images: seen?.images ?? result.images };
    render();
  } catch (err) {
    ctx.progress = null;
    ctx.error = describeAnalyzeError(err);
    render();
  }
}

/** Strips the machine-readable `CONSENT_REQUIRED_ERROR` prefix, if present,
 * leaving the human-readable part `analyze` sent after it. */
function describeAnalyzeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith(CONSENT_REQUIRED_ERROR)) {
    return message.slice(CONSENT_REQUIRED_ERROR.length).replace(/^[:\s-]+/, "") || "This mode needs a fresh download consent — reopen the popup to confirm it.";
  }
  return message;
}

async function clearHighlights(): Promise<void> {
  const tabId = ctx.tabId;
  if (tabId === null) return;
  try {
    await sendTabMessage(tabId, "clearHighlights", undefined);
  } catch {
    // No content script listening yet (T2) — nothing to clear.
  }
}

void main();
