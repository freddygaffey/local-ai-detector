// Background side of the voice check (T11). One call from
// entrypoints/background.ts: registerVoiceBackground().
//  - Gates on settings.voice.enabled, and on download consent while the model
//    isn't cached yet.
//  - Relays clips to the host: Chrome offscreen document (shared helper in
//    src/engine/offscreen.ts), or a dedicated Firefox worker
//    (entrypoints/voice-worker.ts; separate from the text-model worker so the
//    ~1.3 GB voice session can be dropped on its own).
//  - Forwards download progress to the requesting tab.
//  - Adds a "Check voice" context-menu entry on <video> (the on-click path for
//    any site).

import { browser } from "wxt/browser";
import { getSettings } from "../shared/settings";
import { withOffscreen } from "../engine/offscreen";
import { sanitizeVoice } from "./settings";
import {
  isVoiceProgress,
  isVoiceRequest,
  type VoiceHostRequest,
  type VoiceProgress,
  type VoiceRequest,
  type VoiceResponse,
} from "./protocol";

export const MENU_CHECK_VOICE = "lad-check-voice";
export const VOICE_START_KIND = "lad-voice-start";

let counter = 0;
const tabForRequest = new Map<string, number>();

function forwardProgress(p: VoiceProgress): void {
  const tabId = p.id ? tabForRequest.get(p.id) : undefined;
  if (tabId !== undefined) void browser.tabs.sendMessage(tabId, p).catch(() => {});
}

// ---- Firefox: dedicated voice worker ----
let worker: Worker | null = null;
const pending = new Map<string, (r: VoiceResponse) => void>();
let keepAlive: ReturnType<typeof setInterval> | null = null;

function workerCall(req: VoiceHostRequest): Promise<VoiceResponse> {
  if (!worker) {
    const w = new Worker(browser.runtime.getURL("/voice-worker.js" as "/"), { type: "module" });
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as { id?: string; res?: VoiceResponse };
      if (isVoiceProgress(m)) return forwardProgress(m);
      if (m?.id && m.res) {
        pending.get(m.id)?.(m.res);
        pending.delete(m.id);
        if (!pending.size && keepAlive) {
          clearInterval(keepAlive);
          keepAlive = null;
        }
      }
    };
    w.onerror = (e) => {
      e.preventDefault?.();
      worker = null;
      w.terminate();
      for (const r of pending.values()) r({ ok: false, error: e.message || "voice worker crashed", code: "failed" });
      pending.clear();
    };
    worker = w;
  }
  // Firefox unloads an idle event page; keep it up through a long download.
  keepAlive ??= setInterval(() => void browser.runtime.getPlatformInfo().catch(() => {}), 15_000);
  return new Promise((resolve) => {
    pending.set(req.id, resolve);
    worker!.postMessage(req);
  });
}

async function hostCall(req: VoiceHostRequest): Promise<VoiceResponse> {
  if (import.meta.env.FIREFOX) return workerCall(req);
  return withOffscreen(
    () => browser.runtime.sendMessage(req) as Promise<VoiceResponse | undefined>,
    (r) => r === undefined,
  ) as Promise<VoiceResponse>;
}

export async function handleVoiceRequest(req: VoiceRequest, tabId: number | undefined): Promise<VoiceResponse> {
  const settings = await getSettings();
  const voice = sanitizeVoice(settings.voice);
  if (!voice.enabled) return { ok: false, error: "Voice check is off", code: "disabled" };
  const base = { kind: "lad-voice-host" as const, model: voice.model, allowWebGPU: settings.useWebGPU !== false };
  if (req.op === "status") return hostCall({ ...base, id: `vs${++counter}`, op: "status" });
  if (!settings.consentedDownload) {
    const st = await hostCall({ ...base, id: `vs${++counter}`, op: "status" });
    if (!(st.ok && st.cached)) return { ok: false, error: "Model download not allowed yet", code: "consent" };
  }
  const id = `v${Date.now().toString(36)}-${++counter}`;
  if (tabId !== undefined) tabForRequest.set(id, tabId);
  try {
    return await hostCall({ ...base, id, op: "score", pcmB64: req.pcmB64 });
  } finally {
    tabForRequest.delete(id);
  }
}

export function registerVoiceBackground(): void {
  browser.runtime.onMessage.addListener(((msg: unknown, sender: { tab?: { id?: number } }, sendResponse: (r: unknown) => void) => {
    if (isVoiceProgress(msg)) {
      forwardProgress(msg); // Chrome: from the offscreen document
      return undefined;
    }
    if (!isVoiceRequest(msg) || !sender.tab) return undefined;
    void handleVoiceRequest(msg, sender.tab.id).then(sendResponse, (e: unknown) =>
      sendResponse({ ok: false, error: String(e), code: "failed" } satisfies VoiceResponse),
    );
    return true;
  }) as Parameters<typeof browser.runtime.onMessage.addListener>[0]);

  const menus = browser.contextMenus;
  if (menus?.create && menus.onClicked) {
    browser.runtime.onInstalled?.addListener(() => {
      menus.create({ id: MENU_CHECK_VOICE, title: "Check voice (experimental)", contexts: ["video"] }, () => {
        void browser.runtime.lastError;
      });
    });
    menus.onClicked.addListener((info, tab) => {
      if (info.menuItemId !== MENU_CHECK_VOICE || tab?.id === undefined || tab.id < 0) return;
      void browser.tabs.sendMessage(tab.id, { kind: VOICE_START_KIND, srcUrl: info.srcUrl }).catch(() => {});
    });
  }
}
