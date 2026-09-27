// Chrome only: the single offscreen document shared by the inference engine
// (src/engine/host-client.ts) and the provenance relay
// (src/provenance/background.ts). Chrome allows exactly one offscreen
// document per extension, so both features go through this one helper:
// one creation promise, one justification, one retry policy for the short
// window after creation when the document's message listeners aren't
// registered yet.

import { browser } from "wxt/browser";

export const OFFSCREEN_PATH = "offscreen.html";

interface OffscreenApi {
  createDocument(p: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
  hasDocument?: () => Promise<boolean>;
}

export function offscreenApi(): OffscreenApi | undefined {
  return (browser as unknown as { offscreen?: OffscreenApi }).offscreen;
}

function offscreenUrl(): string {
  return (browser.runtime.getURL as (p: string) => string)(`/${OFFSCREEN_PATH}`);
}

export async function hasOffscreenDocument(): Promise<boolean> {
  const api = offscreenApi();
  if (!api) return false;
  const rt = browser.runtime as unknown as {
    getContexts?: (f: { contextTypes: string[]; documentUrls?: string[] }) => Promise<unknown[]>;
  };
  if (rt.getContexts) {
    const ctx = await rt.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [offscreenUrl()] });
    return ctx.length > 0;
  }
  if (api.hasDocument) return api.hasDocument();
  return false;
}

let creating: Promise<void> | null = null;

/** Creates the offscreen document if it doesn't exist. Safe to call concurrently. */
export async function ensureOffscreenDocument(): Promise<void> {
  const api = offscreenApi();
  if (!api) throw new Error("offscreen API unavailable");
  if (await hasOffscreenDocument()) return;
  creating ??= api
    .createDocument({
      url: offscreenUrl(),
      reasons: ["WORKERS"],
      justification:
        "Runs the local AI-text detection models (ONNX Runtime) and the Content Credentials (C2PA) validator in workers, outside the service worker, so they stay loaded between analyses.",
    })
    .catch((e: unknown) => {
      // Lost a race with another caller: only one document may exist.
      if (!/single offscreen|only a single|already/i.test(String(e))) throw e;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

export async function closeOffscreenDocument(): Promise<void> {
  const api = offscreenApi();
  if (api && (await hasOffscreenDocument())) await api.closeDocument().catch(() => {});
}

const NOT_READY = /Receiving end does not exist|Could not establish connection|message port closed|No response for message/i;

/**
 * Ensures the document exists, then runs `call`. Retries (up to ~3 s) while
 * the freshly created document hasn't registered its listeners yet: either
 * the send throws "Receiving end does not exist", or it resolves with
 * `undefined` (`isEmpty`).
 */
export async function withOffscreen<T>(call: () => Promise<T>, isEmpty: (r: T) => boolean = () => false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await ensureOffscreenDocument();
    try {
      const res = await call();
      if (isEmpty(res) && attempt < 30) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt < 30 && NOT_READY.test(String(e))) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      throw e;
    }
  }
}
