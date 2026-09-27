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

function broadcastStatus(tabId: number, status: TabAnalysisStatus, toTab: boolean): void {
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
  meta: { senderTabId?: number; requestId: string },
): Promise<AnalyzeResult> {
  const settings = await getSettings();
  const mode = req.mode ?? settings.mode;
  // A content script doesn't know its own tab id (T2 sends tabId 0), so the
  // sender's tab wins; the popup passes the real id of the active tab.
  const tabId = meta.senderTabId ?? (typeof req.tabId === "number" && req.tabId >= 0 ? req.tabId : -1);
  const models = activeModelsForMode(mode, settings.modelOverrides);
  if (!Array.isArray(req.blocks)) throw new Error("analyze: `blocks` must be an array");

  await checkConsent(mode, models);
  void maybeAutoCheck(managerDeps()).catch(() => {});

  const fromTab = meta.senderTabId !== undefined;
  if (tabId >= 0) {
    broadcastStatus(tabId, { state: "running", mode }, !fromTab);
    badge.progress(tabId);
  }
  let lastTabRelay = 0;
  const relay = (progress: ProgressEvent) => {
    // Requester in an extension page (popup): runtime broadcast.
    sendProgress(meta.requestId, progress);
    // Requester in a content script: runtime.sendMessage doesn't reach tabs.
    if (fromTab) {
      void browser.tabs
        .sendMessage(meta.senderTabId!, { kind: "event", event: "progress", requestId: meta.requestId, progress })
        .catch(() => {});
    }
    if (tabId >= 0) {
      const now = Date.now();
      const final = progress.loaded >= progress.total;
      if (final || now - lastTabRelay > 250) {
        lastTabRelay = now;
        broadcastStatus(tabId, { state: "running", mode, progress }, !fromTab);
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
      broadcastStatus(tabId, { state: "done", mode, result, finishedAt: Date.now() }, !fromTab);
      badge.score(tabId, result.overall);
    }
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (tabId >= 0) {
      broadcastStatus(tabId, { state: "error", mode, error }, !fromTab);
      badge.error(tabId);
    }
    throw err;
  }
}

const MENU_ID = "lad-analyze-selection";

/**
 * "Analyze selected text" context-menu entry: asks the tab's content script
 * for the selection (extractText), analyzes it here, and sends the result
 * back for highlighting (renderHighlights). The menu is (re)created on
 * install/update, as MV3 menus persist across service-worker restarts.
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
    const tabId = tab.id;
    void (async () => {
      try {
        const settings = await getSettings();
        const { blocks } = await sendTabMessage(tabId, "extractText", { target: "selection" });
        if (!blocks.length) throw new Error("No selected text found.");
        const result = await runAnalyze(
          { tabId, mode: settings.mode, blocks },
          { requestId: `menu-${Date.now().toString(36)}` },
        );
        await sendTabMessage(tabId, "renderHighlights", { result, style: settings.highlightStyle });
      } catch (e) {
        console.warn("[engine] context-menu analysis failed", e);
      }
    })();
  });
}

/** Registers every engine message handler. Call once from the background entry. */
export function startEngineRouter(): void {
  const progressTo = (requestId: string) => (p: ProgressEvent) => sendProgress(requestId, p);

  registerHandlers({
    analyze: (req, meta) => runAnalyze(req, meta),
    checkModelUpdates: (req) => checkModelUpdates(req?.slots as ModelSlot[] | undefined, managerDeps()),
    updateModel: (req, meta) => updateModel(req.slot, managerDeps(), progressTo(meta.requestId)),
    rollbackModel: (req, meta) => rollbackModel(req.slot, managerDeps(), progressTo(meta.requestId)),
    setCustomModel: (req, meta) => setCustomModel(req.slot, req.repo, managerDeps(), progressTo(meta.requestId)),
    validateCustomModel: (req) => validateCustomModel(req.slot, req.repo, managerDeps()),
    deleteCachedModel: (req) => deleteCachedModel(req.slot, managerDeps()),
    getModelCacheInfo: () => modelCacheInfo(managerDeps()),
    getTabStatus: (req) => tabStatus.get(req.tabId) ?? { state: "idle" },
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
  });
  browser.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading" && tabStatus.has(tabId)) {
      tabStatus.delete(tabId);
      badge.clear(tabId);
    }
  });

  startContextMenu();

  // Optional daily update check (off by default; never auto-installs).
  void maybeAutoCheck(managerDeps()).catch((e) => console.warn("[engine] update check failed", e));
}
