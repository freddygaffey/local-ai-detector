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
import { activeModelsForMode, estimatedDownloadBytes, slotsForMode } from "./models";

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

async function checkConsent(mode: AnalyzeRequest["mode"], models: ReturnType<typeof activeModelsForMode>): Promise<void> {
  const settings = await getSettings();
  if (settings.consentedDownload) return;
  const items = slotsForMode(mode).map((slot) => ({ slot, ref: models[slot]! }));
  const cached = await getHostClient().call("isCached", { items });
  if (cached.every(Boolean)) return;
  const bytes = estimatedDownloadBytes(mode, "wasm", settings.modelOverrides);
  const size = bytes ? ` (about ${Math.round(bytes / 1e6)} MB, once)` : "";
  throw new Error(
    `${CONSENT_REQUIRED_ERROR}: this mode needs to download its model files from Hugging Face${size}. Allow the download in the popup first.`,
  );
}

async function runAnalyze(
  req: AnalyzeRequest,
  meta: { senderTabId?: number; requestId: string; tabId?: number },
): Promise<AnalyzeResult> {
  const settings = await getSettings();
  const mode = req.mode ?? settings.mode;
  // A content script doesn't know its own tab id (T2 sends tabId 0), so the
  // sender's tab wins; the popup passes the real id of the active tab.
  const tabId = meta.tabId ?? meta.senderTabId ?? (typeof req.tabId === "number" && req.tabId >= 0 ? req.tabId : -1);
  const models = activeModelsForMode(mode, settings.modelOverrides);
  if (!Array.isArray(req.blocks)) throw new Error("analyze: `blocks` must be an array");

  await checkConsent(mode, models);
  void maybeAutoCheck(managerDeps()).catch(() => {});

  if (tabId >= 0) {
    broadcastStatus(tabId, { state: "running", mode });
    badge.progress(tabId);
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
        badge.progress(tabId, progress.phase === "load" ? undefined : pct(progress));
      }
    }
  };

  try {
    const result = await getHostClient().call(
      "analyze",
      {
        blocks: req.blocks,
        config: { mode, minWords: settings.minWords, maxTokens: settings.maxTokens, models },
      },
      relay,
    );
    if (tabId >= 0) {
      broadcastStatus(tabId, { state: "done", mode, result, finishedAt: Date.now() });
      badge.score(tabId, result.overall);
    }
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (tabId >= 0) {
      broadcastStatus(tabId, { state: "error", mode, error });
      badge.error(tabId);
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

const inflight = new Map<number, Promise<AnalyzeResult>>();

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
    if (!/Receiving end does not exist|Could not establish connection|No response for tab message/i.test(String(e))) throw e;
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
    } catch (injectErr) {
      throw new Error(
        `This page can't be read by the extension (${injectErr instanceof Error ? injectErr.message : String(injectErr)}).`,
      );
    }
    return sendTabMessage(tabId, type, payload);
  }
}

export function runTabAnalysis(
  tabId: number,
  target: "page" | "selection",
  requestId: string,
): Promise<AnalyzeResult> {
  const running = inflight.get(tabId);
  if (running) return running;
  imageSummaries.delete(tabId);
  const run = (async () => {
    const settings = await getSettings();
    let blocks: AnalyzeRequest["blocks"];
    try {
      ({ blocks } = await toTab(tabId, "extractText", { target }));
      if (!blocks.length) {
        throw new Error(
          target === "selection"
            ? "Select some text on the page first, then try again."
            : "Couldn't find any readable text on this page.",
        );
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      broadcastStatus(tabId, { state: "error", mode: settings.mode, error });
      throw err;
    }
    const result = await runAnalyze({ tabId, mode: settings.mode, blocks }, { requestId, tabId });
    const fresh = await getSettings();
    await toTab(tabId, "renderHighlights", { result, style: fresh.highlightStyle }).catch((e) =>
      console.warn("[engine] renderHighlights failed", e),
    );
    return result;
  })().finally(() => inflight.delete(tabId));
  inflight.set(tabId, run);
  return run;
}

const MENU_ID = "lad-analyze-selection";

async function onContextMenuSelection(tabId: number): Promise<void> {
  try {
    await runTabAnalysis(tabId, "selection", `menu-${Date.now().toString(36)}`);
  } catch (e) {
    console.warn("[engine] context-menu analysis failed", e);
  }
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
    void onContextMenuSelection(tab.id);
  });
  // Automation can't click native context menus; the E2E suite
  // (scripts/e2e/) calls the same handler through this hook.
  (globalThis as { __ladContextMenuSelection?: (tabId: number) => Promise<void> }).__ladContextMenuSelection =
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
      return runTabAnalysis(tabId, req.target, meta.requestId);
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
