// Background: Chrome service worker / Firefox event page (WXT picks the
// right manifest field per browser). Routes typed messages, owns the
// toolbar badge, and (T9) the extra entry points: context menus for
// analyzing the page/an image/text in a box, keyboard commands, the
// idle-unload alarm, and opening the side panel.
//
// The engine router (src/engine/router.ts) handles `analyze`, `analyzeTab`
// and the model management messages, and its own "Check selected text"
// context menu; this file adds to that rather than duplicating it, reusing
// its exported `runManualCheck` (Quick, then Deep over it) for user-started checks.

import { registerHandlers, sendTabMessage } from "@/src/shared/messages";
import { logQuietly, runManualCheck, startEngineRouter, unloadIdleModels } from "@/src/engine/router";
import { getSettings, watchSettings, type Settings } from "@/src/shared/settings";
import { sidePanelOnIconClick } from "@/src/ui/optionsLogic";
import { clearBadge } from "@/src/ui/badge";
import { registerProvenanceBackground } from "@/src/provenance/background";
import { originPattern, requestImagePermission } from "@/src/provenance/permissions";
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
    await runManualCheck(tabId, "editable", newRequestId(), true);
  } catch (err) {
    logQuietly("'Check text in this box'", err);
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
    // Request straight away, with no await before it: Firefox only allows
    // permissions.request() while the click is still being handled, and an
    // origin that's already granted resolves true without a prompt.
    if (pattern) await requestImagePermission([pattern]).catch(() => false);
    await sendTabMessage(tabId, "checkImageAtUrl", { srcUrl });
  } catch (err) {
    logQuietly("image check", err);
  }
}

/**
 * After an install/update/reload Chrome doesn't add content scripts to tabs
 * that are already open, so they had no card until reloaded or the toolbar
 * icon was clicked. With the optional all-sites permission granted, add it
 * to every open web tab now (an old copy already there retires itself,
 * src/content/lifecycle.ts). Without it, tabs catch up as they're reloaded.
 */
function injectIntoOpenTabs(): void {
  browser.runtime.onInstalled?.addListener(async () => {
    if (import.meta.env.FIREFOX) return; // Firefox injects into open tabs itself
    try {
      if (!(await browser.permissions.contains({ origins: ["<all_urls>"] }))) return;
      for (const tab of await browser.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
        if (tab.id === undefined || tab.discarded) continue;
        void browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["/content-scripts/content.js"] }).catch(() => {});
      }
    } catch {
      // best-effort
    }
  });
}

function startExtraContextMenus(): void {
  const menus = browser.contextMenus;
  if (!menus?.create || !menus.onClicked) return;
  browser.runtime.onInstalled?.addListener(() => {
    menus.create({ id: MENU_ANALYZE_PAGE, title: "Analyze this page for AI writing", contexts: ["page"] }, () => {
      void browser.runtime.lastError;
    });
    menus.create(
      { id: MENU_CHECK_IMAGE, title: "Check image for Content Credentials and watermarks", contexts: ["image"] },
      () => void browser.runtime.lastError,
    );
    menus.create(
      { id: MENU_CHECK_EDITABLE, title: "Check text in this box for AI writing", contexts: ["editable"] },
      () => void browser.runtime.lastError,
    );
  });
  menus.onClicked.addListener((info, tab) => {
    if (tab?.id === undefined || tab.id < 0) return;
    if (info.menuItemId === MENU_ANALYZE_PAGE) void analyzePageQuietly(tab.id);
    else if (info.menuItemId === MENU_CHECK_IMAGE) void checkImageInTab(tab.id, info.srcUrl);
    else if (info.menuItemId === MENU_CHECK_EDITABLE) void analyzeEditableInTab(tab.id);
  });
}

/** "Analyze this page" from the menu: a PDF or protected page fails quietly. */
async function analyzePageQuietly(tabId: number): Promise<void> {
  try {
    await runManualCheck(tabId, "page", newRequestId(), true);
  } catch (err) {
    logQuietly("'Analyze this page'", err);
  }
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
      if (command === "analyze-page") await runManualCheck(tabId, "page", newRequestId(), true);
      else if (command === "analyze-selection") await runManualCheck(tabId, "selection", newRequestId(), true);
      else if (command === "toggle-visibility") await sendTabMessage(tabId, "toggleVisibility", undefined);
    })().catch((err) => logQuietly(`shortcut ${command}`, err));
  });
}

/** Firefox sidebar_action: same Presence behaviour as Chrome's side panel. With
 * "Side panel", the toolbar icon has no popup and toggles the sidebar instead
 * (sidebarAction.toggle() is allowed from action.onClicked, a user action). */
function startFirefoxSidebar(): boolean {
  const sidebar = (browser as unknown as { sidebarAction?: { toggle?: () => Promise<void> } }).sidebarAction;
  if (!sidebar?.toggle || !browser.action?.setPopup) return false;
  const apply = (s: Settings) =>
    void browser.action.setPopup({ popup: sidePanelOnIconClick(s) ? "" : browser.runtime.getURL("/popup.html") }).catch(() => {});
  void getSettings().then(apply);
  watchSettings(apply);
  browser.action.onClicked.addListener(() => void sidebar.toggle!().catch(() => {}));
  return true;
}

/** Chrome sidePanel: open on the toolbar-icon click when the Side panel surface is on; a normal popup otherwise. */
function startSidePanel(): void {
  if (startFirefoxSidebar()) return;
  const sidePanel = (browser as unknown as { sidePanel?: { setPanelBehavior?: (opts: { openPanelOnActionClick: boolean }) => Promise<void> } })
    .sidePanel;
  if (!sidePanel?.setPanelBehavior) return;
  void getSettings().then((s) => sidePanel.setPanelBehavior!({ openPanelOnActionClick: sidePanelOnIconClick(s) }).catch(() => {}));
  watchSettings((s) => {
    void sidePanel.setPanelBehavior!({ openPanelOnActionClick: sidePanelOnIconClick(s) }).catch(() => {});
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
    // The corner card's "Settings" (content scripts can't open it themselves).
    openOptions: async () => {
      await browser.runtime.openOptionsPage();
      return { ok: true as const };
    },
  });

  startEngineRouter();
  startExtraContextMenus();
  injectIntoOpenTabs();
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
