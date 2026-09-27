// Reusable toast for the popup, side panel and options
// (docs/integration-notes.md "For T12": "minor or expected conditions ...
// use toasts. Full error states are only for real failures."). One host
// per page, mounted once; `showToast` queues messages so a fast double
// click doesn't cut the first one off mid-fade.

const HOST_ID = "lad-toast-host";
const DEFAULT_DURATION_MS = 2200;

let host: HTMLElement | null = null;
let hiding: ReturnType<typeof setTimeout> | undefined;
let queue: { message: string; durationMs: number }[] = [];
let showing = false;

/** Mounts the toast host into `parent` (defaults to <body>). Safe to call more than once. */
export function mountToastHost(parent: ParentNode = document.body): void {
  if (host?.isConnected) return;
  host = document.getElementById(HOST_ID);
  if (host) return;
  host = document.createElement("div");
  host.id = HOST_ID;
  host.className = "lad-toast";
  host.setAttribute("role", "status");
  host.setAttribute("aria-live", "polite");
  parent.appendChild(host);
}

function next(): void {
  if (showing || !host) return;
  const item = queue.shift();
  if (!item) return;
  showing = true;
  host.textContent = item.message;
  host.classList.add("is-visible");
  clearTimeout(hiding);
  hiding = setTimeout(() => {
    host?.classList.remove("is-visible");
    showing = false;
    setTimeout(next, 150); // let the fade-out finish before the next one
  }, item.durationMs);
}

/** Shows a brief, non-blocking message. Mounts the host itself if needed. */
export function showToast(message: string, durationMs = DEFAULT_DURATION_MS): void {
  mountToastHost();
  queue.push({ message, durationMs });
  next();
}

/** Test/dev only: clears any pending or visible toast. */
export function resetToastForTests(): void {
  clearTimeout(hiding);
  queue = [];
  showing = false;
  host?.classList.remove("is-visible");
}
