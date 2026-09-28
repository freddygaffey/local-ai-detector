// Chrome offscreen document -> dedicated Worker relay. The offscreen page
// shares the extension's renderer process (and its main thread) with the
// popup, side panel and options page, so inference must not run on it: a
// running check left the popup unable to paint for seconds. The offscreen
// page only forwards host requests to a Worker (the same host Firefox runs)
// and relays progress and replies back over runtime messaging.

interface MinimalRuntime {
  id?: string;
  onMessage: {
    addListener(
      cb: (msg: unknown, sender: { id?: string; tab?: unknown }, sendResponse: (r: unknown) => void) => boolean | undefined,
    ): void;
  };
  sendMessage(msg: unknown): Promise<unknown> | void;
}

export interface RelaySpec {
  workerUrl: string;
  isRequest(msg: unknown): msg is { id: string };
  /** A worker message that answers a request: its id and the reply to send. Anything else is progress. */
  asReply(data: unknown): { id: string; reply: unknown } | null;
  /** Reply for requests in flight when the worker crashes. */
  crashReply(id: string, message: string): unknown;
}

export function startOffscreenRelay(runtime: MinimalRuntime, spec: RelaySpec): void {
  let worker: Worker | null = null;
  const pending = new Map<string, (r: unknown) => void>();

  function ensure(): Worker {
    if (worker) return worker;
    const w = new Worker(spec.workerUrl, { type: "module" });
    w.onmessage = (e: MessageEvent) => {
      const reply = spec.asReply(e.data);
      if (reply) {
        pending.get(reply.id)?.(reply.reply);
        pending.delete(reply.id);
        return;
      }
      try {
        const p = runtime.sendMessage(e.data);
        if (p && typeof (p as Promise<unknown>).catch === "function") (p as Promise<unknown>).catch(() => {});
      } catch {
        // progress is best-effort
      }
    };
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      console.error("[engine] offscreen worker crashed", e.message);
      worker = null;
      w.terminate();
      for (const [id, send] of pending) send(spec.crashReply(id, `Inference worker crashed: ${e.message || "unknown error"}`));
      pending.clear();
    };
    worker = w;
    return w;
  }

  runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!spec.isRequest(msg)) return undefined;
    // Only the extension's own background (not content scripts in tabs) drives the host.
    if (sender.tab || (sender.id && runtime.id && sender.id !== runtime.id)) return undefined;
    pending.set(msg.id, sendResponse);
    ensure().postMessage(msg);
    return true; // async sendResponse
  });
}
