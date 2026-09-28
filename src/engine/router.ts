// Background router for the engine: registers the analyze + model-management
// message handlers, forwards work to the inference host (Chrome offscreen
// document / Firefox Worker, re-created on demand), relays progress to the
// requester (popup via runtime broadcast, content script via
// tabs.sendMessage), tracks per-tab analysis status for the popup, drives the
// toolbar badge, and runs the optional daily model-update check.

import { browser } from "wxt/browser";
import {
  CONSENT_REQUIRED_ERROR,
  registerHandlers,
  sendProgress,
  sendTabMessage,
  type AnalysisStatusEnvelope,
  type AnalyzeRequest,
  type AnalyzeResult,
  type ImageProvenanceSummary,
  type ProgressEvent,
  type TabAnalysisStatus,
} from "../shared/messages";
import { getSettings, setSettings, type ModelSlot } from "../shared/settings";
import { needsQuickConfirm } from "../shared/thresholds";
import { isUnscriptableError, kindForUrl, parseUnreadable, unreadableError } from "../shared/unreadable";
import { badge } from "./badge-hook";
import { getHostClient } from "./host-client";
import {
  checkModelUpdates,
  deleteCachedModel,
  lastUpdateCheck,
  maybeAutoCheck,
  modelCacheInfo,
  rollbackModel,
  setCustomModel,
  updateModel,
  validateCustomModel,
  type ManagerDeps,
} from "./model-manager";
import { activeModelsForMode, estimatedDownloadBytes, slotsForMode, type FusionSpec } from "./models";
import { decidePowerAction, readBatteryState } from "../power/battery";
import type { Settings } from "../shared/settings";
import type { EngineConfig } from "./protocol";

type EngineWebgpuDtypes = EngineConfig["webgpuDtypes"];

const tabStatus = new Map<number, TabAnalysisStatus>();
const imageSummaries = new Map<number, ImageProvenanceSummary>();

function managerDeps(): ManagerDeps {
  const host = getHostClient();
  return {
    fetch: (url) => fetch(url, { credentials: "omit", cache: "no-store" }),
    getSettings,
    setSettings,
    host: {
      prepare: (slot, ref, onProgress) => host.call("prepare", { slot, ref }, onProgress),
      deleteCache: (refs) => host.call("deleteCache", { refs }),
      cacheInfo: () => host.call("cacheInfo", undefined),
    },
    store: {
      get: async (key) => (await browser.storage.local.get(key))[key],
      set: async (key, value) => {
        await browser.storage.local.set({ [key]: value });
      },
    },
    now: () => Date.now(),
  };
}

function broadcastStatus(tabId: number, status: TabAnalysisStatus, toTab = true): void {
  tabStatus.set(tabId, status);
  const env: AnalysisStatusEnvelope = { kind: "event", event: "analysisStatus", tabId, status };
  void browser.runtime.sendMessage(env).catch(() => {});
  if (toTab && tabId >= 0) void browser.tabs.sendMessage(tabId, env).catch(() => {});
}

function pct(p: ProgressEvent): number | undefined {
  return p.total > 0 ? (100 * p.loaded) / p.total : undefined;
}

async function checkConsent(
  mode: AnalyzeRequest["mode"],
  models: ReturnType<typeof activeModelsForMode>,
  fusion: FusionSpec,
): Promise<void> {
  const settings = await getSettings();
  if (settings.consentedDownload) return;
  const items = slotsForMode(mode, fusion).map((slot) => ({ slot, ref: models[slot]! }));
  const cached = await getHostClient().call("isCached", { items });
  if (cached.every(Boolean)) return;
  const bytes = estimatedDownloadBytes(mode, settings.useWebGPU ? "webgpu-f16" : "wasm", settings.modelOverrides, fusion);
  const size = bytes ? ` (about ${Math.round(bytes / 1e6)} MB, once)` : "";
  throw new Error(
    `${CONSENT_REQUIRED_ERROR}: this mode needs to download its model files from Hugging Face${size}. Allow the download in the popup first.`,
  );
}

/**
 * T12b: whether this analysis should run on the CPU (WASM). An explicit
 * `preferCpu` from the requester wins; otherwise the battery-saver
 * decision from src/power, with whatever battery state this context can
 * read (the manual override always counts; service workers and Firefox have
 * no Battery Status API, so there only the override applies).
 */
export async function shouldPreferCpu(settings: Settings, explicit: boolean | undefined): Promise<boolean> {
  if (typeof explicit === "boolean") return explicit;
  if (!settings.battery?.useCpuOnBattery) return false;
  const battery = await readBatteryState();
  return decidePowerAction(battery, { supported: false, level: "nominal" }, settings.battery).preferCpu;
}

/** T12b: the toolbar badge only when the "badge" result surface is on. */
function badgeOn(settings: Settings): boolean {
  return settings.surfaces?.badge !== false;
}

/** True once any analysis has used the inference host (so idle-unload doesn't spin one up). */
let hostUsed = false;

/**
 * T12b: battery-saver idle unload. Frees every loaded model session in the
 * inference host (the next analysis reloads them from the model cache).
 * No-op if nothing has run since the last unload, so it never starts an
 * offscreen document or worker just to unload it. Never throws.
 *
 * Call it directly from the background's idle alarm: a background page
 * doesn't receive its own `runtime.sendMessage`, so the `unloadIdleModels`
 * message handler below only serves other senders (e.g. the options page).
 */
export async function unloadIdleModels(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!hostUsed) return { ok: true };
  try {
    await getHostClient().call("unload", {});
    hostUsed = false;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function runAnalyze(
  req: AnalyzeRequest,
  meta: { senderTabId?: number; requestId: string; tabId?: number },
): Promise<AnalyzeResult> {
  const settings = await getSettings();
  const mode = req.mode ?? settings.mode;
  // A content script doesn't know its own tab id (T2 sends tabId 0), so the
  // sender's tab wins; the popup passes the real id of the active tab.
  // An explicit tabId of -1 means "not this page's result" (transcript
  // blocks, search snippets, the popup's paste box, model warm-up): it must
  // not become the tab's status, badge or popup score.
  const tabId = req.tabId === -1 ? -1 : (meta.tabId ?? meta.senderTabId ?? (typeof req.tabId === "number" && req.tabId >= 0 ? req.tabId : -1));
  // Tiers task: a Deep (or explicit Quick) check overrides the Fusion
  // detector set for this run only, instead of `settings.fusion` (docs/plan.md
  // "Two tiers").
  const fusion: FusionSpec = req.fusionOverride ? { detectors: req.fusionOverride, method: "weighted" } : settings.fusion;
  const models = activeModelsForMode(mode, settings.modelOverrides, fusion);
  if (!Array.isArray(req.blocks)) throw new Error("analyze: `blocks` must be an array");

  await checkConsent(mode, models, fusion);
  const preferCpu = await shouldPreferCpu(settings, req.preferCpu);
  const showBadge = badgeOn(settings);
  void maybeAutoCheck(managerDeps()).catch(() => {});

  if (tabId >= 0) {
    broadcastStatus(tabId, { state: "running", mode });
    if (showBadge) badge.progress(tabId);
    else badge.clear(tabId);
  }
  let lastTabRelay = 0;
  const relay = (progress: ProgressEvent) => {
    // Requester in an extension page (popup): per-request progress events.
    sendProgress(meta.requestId, progress);
    // Everyone else (the pill in the tab, a popup opened later) follows the
    // throttled tab status.
    if (tabId >= 0) {
      const now = Date.now();
      const final = progress.loaded >= progress.total;
      if (final || now - lastTabRelay > 250) {
        lastTabRelay = now;
        broadcastStatus(tabId, { state: "running", mode, progress });
        if (showBadge) badge.progress(tabId, progress.phase === "load" ? undefined : pct(progress));
      }
    }
  };

  try {
    hostUsed = true;
    const result = await getHostClient().call(
      "analyze",
      {
        blocks: req.blocks,
        config: {
          mode,
          minWords: settings.minWords,
          // The Quick pass (and its confirmation) is capped; Deep reads up to maxTokens.
          maxTokens: req.tier === "quick" ? Math.min(settings.maxTokens, settings.tiers.quickMaxTokens) : settings.maxTokens,
          models,
          fusion,
          itemBlocks: req.itemBlocks,
          allowWebGPU: settings.useWebGPU && !preferCpu,
          // E2E/calibration builds only: dtype experiments (scripts/e2e/browser-t7-calibration.mjs).
          webgpuDtypes:
            import.meta.env.MODE === "e2e"
              ? ((await browser.storage.local.get("ladDevWebgpuDtypes")).ladDevWebgpuDtypes as EngineWebgpuDtypes | undefined)
              : undefined,
        },
      },
      relay,
    );
    // Tiers task: echo which pass this was, so the popup/pill can label a
    // Deep result and (once it exists) a YouTube voice check can read the
    // active tier (docs/plan.md "Two tiers").
    const tagged = req.tier
      ? {
          ...result,
          tier: req.tier,
          // Quick is capped by design (settings.tiers.quickMaxTokens); point at Deep, not at the global limit.
          notes:
            req.tier === "quick"
              ? result.notes.map((n) => (n.startsWith("Only the first ~") ? "Quick check read part of the page. Deep check (↻) reads all of it." : n))
              : result.notes,
        }
      : result;
    if (tabId >= 0) {
      broadcastStatus(tabId, { state: "done", mode, result: tagged, finishedAt: Date.now() });
      // The badge shows the same calibrated P(AI) as every other surface; nothing when too short to score.
      if (showBadge) {
        if (tagged.probability !== undefined) badge.score(tabId, tagged.probability);
        else badge.clear(tabId);
      }
    }
    return tagged;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (tabId >= 0) {
      broadcastStatus(tabId, { state: "error", mode, error });
      if (showBadge) badge.error(tabId);
    }
    throw err;
  }
}

// ---------------- One analysis path for every entry point ----------------
//
// Popup buttons, the in-page pill ("Scan page" / autoRun) and the context
// menu all end up in runTabAnalysis(): extract in the tab -> analyze here ->
// render in the tab. State and progress reach the popup and the pill through
// `analysisStatus` events, so it doesn't matter who started a run.

const inflight = new Map<number, { key: string; run: Promise<AnalyzeResult> }>();

const CONTENT_SCRIPT_FILE = "/content-scripts/content.js";

/** Sends to the tab's content script, injecting it once if the tab predates the extension. */
async function toTab<T extends "extractText" | "renderHighlights">(
  tabId: number,
  type: T,
  payload: Parameters<typeof sendTabMessage<T>>[2],
) {
  try {
    return await sendTabMessage(tabId, type, payload);
  } catch (e) {
    if (parseUnreadable(e)) throw e; // the content script says: a PDF
    if (!/Receiving end does not exist|Could not establish connection|No response for tab message/i.test(String(e))) throw e;
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
    } catch {
      // PDF viewer, browser/store page, file: without access: nothing to inject into.
      throw unreadableError(kindForUrl(await tabUrl(tabId)));
    }
    return sendTabMessage(tabId, type, payload);
  }
}

async function tabUrl(tabId: number): Promise<string | undefined> {
  try {
    return (await browser.tabs.get(tabId)).url;
  } catch {
    return undefined;
  }
}

/** Where a run from a menu or shortcut fails on an unreadable page: a debug line, never an error. */
export function logQuietly(label: string, err: unknown): void {
  if (isUnscriptableError(err)) console.debug(`[Local AI Detector] ${label}: page not readable`);
  else console.warn(`[Local AI Detector] ${label} failed`, err);
}

export function runTabAnalysis(
  tabId: number,
  target: "page" | "selection" | "editable",
  requestId: string,
  /** Detector mode for this run (e.g. the auto-run fast mode); default settings.mode. */
  mode?: AnalyzeRequest["mode"],
  /** T12b: force the CPU for this run (see shouldPreferCpu). */
  preferCpu?: boolean,
  /** Tiers task: which pass this is ('quick'/'deep'), echoed onto the result. */
  tier?: AnalyzeRequest["tier"],
  /** Tiers task: override `settings.fusion.detectors` for this run only (the tier's own set). */
  fusionOverride?: AnalyzeRequest["fusionOverride"],
  /** Quick tier: re-check an AI-leaning result with this set before rendering it. */
  confirmWith?: AnalyzeRequest["fusionOverride"],
  /** A run the user asked for from outside the popup (context menu, shortcut): show it on the page. */
  reveal?: boolean,
): Promise<AnalyzeResult> {
  // Same run already going: share it. A different mode/tier (e.g. a Deep
  // click while the auto-run Quick pass is going) queues behind it instead.
  const key = `${target}|${mode ?? ""}|${preferCpu ?? ""}|${tier ?? ""}`;
  const running = inflight.get(tabId);
  if (running?.key === key) return running.run;
  const before = running?.run.catch(() => undefined);
  const run = (async () => {
    await before;
    imageSummaries.delete(tabId);
    const settings = await getSettings();
    let blocks: AnalyzeRequest["blocks"];
    let itemBlocks: boolean | undefined;
    try {
      ({ blocks, items: itemBlocks } = await toTab(tabId, "extractText", { target }));
      if (!blocks.length) {
        throw new Error(
          target === "selection"
            ? "Select some text on the page first, then try again."
            : target === "editable"
              ? "This box is empty."
            : "Couldn't find any readable text on this page.",
        );
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      broadcastStatus(tabId, { state: "error", mode: settings.mode, error });
      throw err;
    }
    let result = await runAnalyze(
      { tabId, mode: mode ?? settings.mode, blocks, preferCpu, tier, fusionOverride, itemBlocks },
      { requestId, tabId },
    );
    // Quick tier: the cheap pass only screens. An AI-leaning page is
    // re-checked with the default Fusion set (docs/calibration.md "Quick tier
    // and false positives"); if that can't run (models not downloaded, an
    // error), the Quick result stands.
    const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((d) => b.includes(d));
    if (confirmWith?.length && !sameSet(confirmWith, fusionOverride ?? []) && needsQuickConfirm(result)) {
      try {
        const confirmed = await runAnalyze(
          { tabId, mode: "ensemble", blocks, preferCpu, tier, fusionOverride: confirmWith, itemBlocks },
          { requestId, tabId },
        );
        result = { ...confirmed, confirmed: true };
        if (tabId >= 0) broadcastStatus(tabId, { state: "done", mode: "ensemble", result, finishedAt: Date.now() });
      } catch (e) {
        console.warn("[engine] quick confirmation skipped", e);
        if (tabId >= 0) broadcastStatus(tabId, { state: "done", mode: mode ?? settings.mode, result, finishedAt: Date.now() });
      }
    }
    const fresh = await getSettings();
    await toTab(tabId, "renderHighlights", { result, style: fresh.highlightStyle, reveal }).catch((e) =>
      console.warn("[engine] renderHighlights failed", e),
    );
    return result;
  })().finally(() => {
    if (inflight.get(tabId)?.run === run) inflight.delete(tabId);
  });
  inflight.set(tabId, { key, run });
  return run;
}

const MENU_ID = "lad-analyze-selection";

async function onContextMenuSelection(tabId: number, selectionText?: string): Promise<void> {
  const requestId = `menu-${Date.now().toString(36)}`;
  try {
    await runTabAnalysis(tabId, "selection", requestId, undefined, undefined, undefined, undefined, undefined, true);
  } catch (e) {
    // A PDF (or other page we can't script): Chrome still hands us the selected
    // text, so check that here. The result reaches the side panel and the popup
    // through the tab status, and the toolbar badge shows the %.
    const text = selectionText?.trim();
    if (text && isUnscriptableError(e)) {
      try {
        await analyzeSelectionText(tabId, text, requestId);
      } catch (e2) {
        logQuietly("selected-text check", e2);
      }
      return;
    }
    logQuietly("context-menu analysis", e);
  }
}

/** Analyses the context menu's own selectionText in the background (no page access needed). */
export async function analyzeSelectionText(tabId: number, text: string, requestId: string): Promise<AnalyzeResult> {
  const settings = await getSettings();
  const block = { id: "selection-0", text, sentences: [] };
  return runAnalyze({ tabId, mode: settings.mode, blocks: [block] }, { requestId, tabId });
}

/**
 * "Check selected text" context-menu entry -> runTabAnalysis(tab, "selection").
 * The menu is (re)created on install/update, as MV3 menus persist across
 * service-worker restarts.
 */
function startContextMenu(): void {
  const menus = browser.contextMenus;
  if (!menus?.create || !menus.onClicked) return;
  browser.runtime.onInstalled?.addListener(() => {
    void Promise.resolve(menus.removeAll?.())
      .catch(() => {})
      .then(() => {
        menus.create({ id: MENU_ID, title: "Check selected text for AI writing", contexts: ["selection"] }, () => {
          void browser.runtime.lastError; // swallow "duplicate id"
        });
      });
  });
  menus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== MENU_ID || tab?.id === undefined || tab.id < 0) return;
    void onContextMenuSelection(tab.id, info.selectionText);
  });
  // Automation can't click native context menus; the E2E suite
  // (scripts/e2e/) calls the same handler through this hook.
  (globalThis as { __ladContextMenuSelection?: (tabId: number, selectionText?: string) => Promise<void> }).__ladContextMenuSelection =
    onContextMenuSelection;
}

/** Registers every engine message handler. Call once from the background entry. */
export function startEngineRouter(): void {
  const progressTo = (requestId: string) => (p: ProgressEvent) => sendProgress(requestId, p);

  registerHandlers({
    analyze: (req, meta) => runAnalyze(req, meta),
    analyzeTab: (req, meta) => {
      const tabId = meta.senderTabId ?? req.tabId;
      if (typeof tabId !== "number" || tabId < 0) throw new Error("No tab to analyze.");
      return runTabAnalysis(tabId, req.target, meta.requestId, req.mode, req.preferCpu, req.tier, req.fusionOverride, req.confirmWith);
    },
    reportImageSummary: (req, meta) => {
      const tabId = meta.senderTabId;
      if (tabId === undefined) return { ok: false, error: "not from a tab" };
      imageSummaries.set(tabId, req.summary);
      const status = tabStatus.get(tabId);
      if (status?.state === "done") {
        broadcastStatus(tabId, { ...status, result: { ...status.result, images: req.summary } }, false);
      }
      return { ok: true };
    },
    checkModelUpdates: (req) => checkModelUpdates(req?.slots as ModelSlot[] | undefined, managerDeps()),
    updateModel: (req, meta) => updateModel(req.slot, managerDeps(), progressTo(meta.requestId)),
    rollbackModel: (req, meta) => rollbackModel(req.slot, managerDeps(), progressTo(meta.requestId)),
    setCustomModel: (req, meta) => setCustomModel(req.slot, req.repo, managerDeps(), progressTo(meta.requestId)),
    validateCustomModel: (req) => validateCustomModel(req.slot, req.repo, managerDeps()),
    deleteCachedModel: (req) => deleteCachedModel(req.slot, managerDeps()),
    getModelCacheInfo: () => modelCacheInfo(managerDeps()),
    // T12b: battery-saver idle unload (timed by entrypoints/background.ts via
    // src/power/idle.ts). Frees every model session; the next analysis
    // reloads from the cache. Never starts an inference host just to unload.
    unloadIdleModels: () => unloadIdleModels(),
    getTabStatus: (req) => {
      const status = tabStatus.get(req.tabId) ?? { state: "idle" };
      const images = imageSummaries.get(req.tabId);
      return status.state === "done" && images ? { ...status, result: { ...status.result, images } } : status;
    },
    getEngineInfo: async () => {
      const deps = managerDeps();
      const [runtime, last] = await Promise.all([
        getHostClient()
          .call("runtime", undefined)
          .catch(() => null),
        lastUpdateCheck(deps),
      ]);
      // Before the first analysis the host reports what it detected; with
      // useWebGPU off, analyses will run on WASM, so say that.
      const settings = await getSettings();
      if (runtime && runtime.device === "webgpu" && !settings.useWebGPU) runtime.device = "wasm";
      return { runtime, lastUpdateCheck: last };
    },
  });

  // Forget per-tab state when a tab closes or navigates.
  browser.tabs?.onRemoved?.addListener((tabId) => {
    tabStatus.delete(tabId);
    imageSummaries.delete(tabId);
  });
  browser.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading" && tabStatus.has(tabId)) {
      tabStatus.delete(tabId);
      imageSummaries.delete(tabId);
      badge.clear(tabId);
    }
  });

  startContextMenu();

  // Optional daily update check (off by default; never auto-installs).
  void maybeAutoCheck(managerDeps()).catch((e) => console.warn("[engine] update check failed", e));
}
