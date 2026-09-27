// Background: Chrome service worker / Firefox event page (WXT picks the
// right manifest field per browser). Routes typed messages, owns the
// toolbar badge, and (T9) the extra entry points: context menus for
// analyzing the page/an image/text in a box, keyboard commands, the
// idle-unload alarm, and opening the side panel.
//
// The engine router (src/engine/router.ts) handles `analyze`, `analyzeTab`
// and the model management messages, and its own "Check selected text"
// context menu; this file adds to that rather than duplicating it, reusing
// its exported `runTabAnalysis` for the page/selection cases.

import { registerHandlers, sendTabMessage } from "@/src/shared/messages";
import { runTabAnalysis, startEngineRouter, unloadIdleModels } from "@/src/engine/router";
import { getSettings, watchSettings } from "@/src/shared/settings";
import { clearBadge } from "@/src/ui/badge";
import { registerProvenanceBackground } from "@/src/provenance/background";
import { hasImagePermission, originPattern, requestImagePermission } from "@/src/provenance/permissions";
import { isIdleTooLong } from "@/src/power/idle";
import { registerVoiceBackground } from "@/src/voice/background";

const MENU_ANALYZE_PAGE = "lad-analyze-page";
const MENU_CHECK_IMAGE = "lad-check-image";
const MENU_CHECK_EDITABLE = "lad-check-editable";

function newRequestId(): string {
  return `menu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** "Check text in this box" -- extractText(editable) -> analyze -> renderHighlights, same shape as
 * runTabAnalysis but for a target router.ts doesn't accept (it only takes "page" | "selection"). */
async function analyzeEditableInTab(tabId: number): Promise<void> {
  try {
    // Straight through the router: a service worker's own runtime.sendMessage
    // never reaches its own listeners ("No response for message analyze").
    await runTabAnalysis(tabId, "editable", newRequestId(), undefined, undefined, undefined, undefined, undefined, true);
  } catch (err) {
    console.warn("[Local AI Detector] 'Check text in this box' failed", err);
  }
}

// Exposed the same way src/engine/router.ts exposes __ladContextMenuSelection:
// native context menus can't be clicked from automation (scripts/e2e/chrome.mjs),
// so tests invoke the handler directly through this hook instead.
(globalThis as unknown as { __ladContextMenuEditable?: (tabId: number) => Promise<void> }).__ladContextMenuEditable =
  analyzeEditableInTab;

/** "Check image for Content Credentials & watermarks" -- best-effort optional-permission
 * request from the click itself, then delegates to the content script's single-image check. */
async function checkImageInTab(tabId: number, srcUrl: string | undefined): Promise<void> {
  if (!srcUrl) return;
  try {
    const pattern = originPattern(srcUrl);
    if (pattern && !(await hasImagePermission([pattern]))) {
      await requestImagePermission([pattern]).catch(() => false);
    }
    await sendTabMessage(tabId, "checkImageAtUrl", { srcUrl });
  } catch (err) {
    console.warn("[Local AI Detector] image check failed", err);
  }
}

function startExtraContextMenus(): void {
  const menus = browser.contextMenus;
  if (!menus?.create || !menus.onClicked) return;
  browser.runtime.onInstalled?.addListener(() => {
    menus.create({ id: MENU_ANALYZE_PAGE, title: "Analyze this page for AI writing", contexts: ["page"] }, () => {
      void browser.runtime.lastError;
    });
    menus.create(
      { id: MENU_CHECK_IMAGE, title: "Check image for Content Credentials & watermarks", contexts: ["image"] },
      () => void browser.runtime.lastError,
    );
    menus.create(
      { id: MENU_CHECK_EDITABLE, title: "Check text in this box for AI writing", contexts: ["editable"] },
      () => void browser.runtime.lastError,
    );
  });
  menus.onClicked.addListener((info, tab) => {
    if (tab?.id === undefined || tab.id < 0) return;
    if (info.menuItemId === MENU_ANALYZE_PAGE) void runTabAnalysis(tab.id, "page", newRequestId(), undefined, undefined, undefined, undefined, undefined, true);
    else if (info.menuItemId === MENU_CHECK_IMAGE) void checkImageInTab(tab.id, info.srcUrl);
    else if (info.menuItemId === MENU_CHECK_EDITABLE) void analyzeEditableInTab(tab.id);
  });
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function startCommands(): void {
  browser.commands?.onCommand.addListener((command) => {
    void (async () => {
      const tabId = await activeTabId();
      if (tabId === undefined) return;
      if (command === "analyze-page") await runTabAnalysis(tabId, "page", newRequestId(), undefined, undefined, undefined, undefined, undefined, true);
      else if (command === "analyze-selection") await runTabAnalysis(tabId, "selection", newRequestId(), undefined, undefined, undefined, undefined, undefined, true);
      else if (command === "toggle-visibility") await sendTabMessage(tabId, "toggleVisibility", undefined).catch(() => {});
    })();
  });
}

/** Firefox sidebar_action: same Presence behaviour as Chrome's side panel. With
 * "Side panel", the toolbar icon has no popup and toggles the sidebar instead
 * (sidebarAction.toggle() is allowed from action.onClicked, a user action). */
function startFirefoxSidebar(): boolean {
  const sidebar = (browser as unknown as { sidebarAction?: { toggle?: () => Promise<void> } }).sidebarAction;
  if (!sidebar?.toggle || !browser.action?.setPopup) return false;
  const apply = (s: { presence: string }) =>
    void browser.action.setPopup({ popup: s.presence === "sidePanel" ? "" : browser.runtime.getURL("/popup.html") }).catch(() => {});
  void getSettings().then(apply);
  watchSettings(apply);
  browser.action.onClicked.addListener(() => void sidebar.toggle!().catch(() => {}));
  return true;
}

/** Chrome sidePanel: open on the toolbar-icon click when Presence is "Side panel"; a normal popup otherwise. */
function startSidePanel(): void {
  if (startFirefoxSidebar()) return;
  const sidePanel = (browser as unknown as { sidePanel?: { setPanelBehavior?: (opts: { openPanelOnActionClick: boolean }) => Promise<void> } })
    .sidePanel;
  if (!sidePanel?.setPanelBehavior) return;
  void getSettings().then((s) => sidePanel.setPanelBehavior!({ openPanelOnActionClick: s.presence === "sidePanel" }).catch(() => {}));
  watchSettings((s) => {
    void sidePanel.setPanelBehavior!({ openPanelOnActionClick: s.presence === "sidePanel" }).catch(() => {});
  });
}

// ---- Idle-unload alarm (docs/plan.md "T8: Battery saver") -------------------

const IDLE_ALARM = "lad-idle-unload";
let lastActiveMs = Date.now();

function startIdleUnload(): void {
  if (!browser.alarms) return;
  const bump = () => {
    lastActiveMs = Date.now();
  };
  // Any of these count as "active" for idle-unload purposes.
  browser.tabs?.onUpdated?.addListener(bump);
  browser.runtime.onMessage.addListener(() => {
    bump();
    return undefined;
  });
  browser.alarms.create(IDLE_ALARM, { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== IDLE_ALARM) return;
    void getSettings().then((settings) => {
      if (!isIdleTooLong(lastActiveMs, Date.now(), settings.battery.unloadAfterMinutes)) return;
      // Best-effort: the engine (T7) may not implement this handler yet.
      // A background page doesn't receive its own runtime.sendMessage broadcasts,
      // so this must call the engine directly rather than message itself.
      void unloadIdleModels();
    });
  });
}

export default defineBackground(() => {
  console.log("[Local AI Detector] background started", browser.runtime.id);

  // Badge starts clear; the engine calls setBadgeProgress/setBadgeScore/setBadgeError
  // from src/ui/badge.ts as real analyze progress/results/errors come in,
  // and clearBadge(tabId) on navigation.
  clearBadge();

  registerHandlers({
    ping: () => ({ ok: true, ts: Date.now() }),
  });

  startEngineRouter();
  startExtraContextMenus();
  startCommands();
  startSidePanel();
  startIdleUnload();

  // E2E builds only (`--mode e2e`, never shipped): see src/e2e/bridge.ts.
  if (import.meta.env.MODE === "e2e") {
    void import("@/src/e2e/bridge").then(({ installBackgroundBridge }) =>
      installBackgroundBridge({
        contextMenuSelection: (tabId) =>
          (globalThis as unknown as { __ladContextMenuSelection: (id: number) => Promise<void> }).__ladContextMenuSelection(tabId),
      }),
    );
  }
  registerProvenanceBackground();
  registerVoiceBackground(); // T11 voice check

  void getSettings().then((settings) => {
    console.log("[Local AI Detector] settings loaded", settings);
  });
  watchSettings((settings) => {
    console.log("[Local AI Detector] settings changed", settings);
  });
});
