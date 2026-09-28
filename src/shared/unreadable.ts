// Pages the extension can't read: PDFs (Chrome's viewer, Firefox's pdf.js),
// browser-internal pages, extension stores, other extensions' pages, file:
// without "Allow access to file URLs". Pure, so the popup, side panel and
// background all classify the same way and it's unit-testable.

export type UnreadableKind = "pdf" | "restricted";

/** Error-message prefix for "this page can't be read", e.g. `unreadable-page:pdf`. */
export const UNREADABLE_ERROR = "unreadable-page";

export function unreadableError(kind: UnreadableKind): Error {
  return new Error(`${UNREADABLE_ERROR}:${kind}`);
}

/** The kind from an error (or its message) made by unreadableError, else null. */
export function parseUnreadable(err: unknown): UnreadableKind | null {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const m = msg.match(/unreadable-page:(pdf|restricted)/);
  return m ? (m[1] as UnreadableKind) : null;
}

/** One quiet line per kind (popup and side panel). */
export function unreadableMessage(kind: UnreadableKind): string {
  return kind === "pdf" ? "PDF — can't read this page. Select text → right-click to check it." : "Can't read this page.";
}

const RESTRICTED_PROTOCOLS = new Set([
  "chrome:",
  "chrome-extension:",
  "edge:",
  "about:",
  "moz-extension:",
  "view-source:",
  "devtools:",
  "chrome-search:",
  "chrome-error:",
  "chrome-untrusted:",
  "resource:",
  "data:",
  "javascript:",
]);

const RESTRICTED_HOSTS = [
  /^chrome\.google\.com$/,
  /^chromewebstore\.google\.com$/,
  /^addons\.mozilla\.org$/,
  /^microsoftedge\.microsoft\.com$/,
];

/** Chrome's built-in PDF viewer extension. */
const CHROME_PDF_VIEWER = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

/** What the URL alone says: "pdf", "restricted", or null (probably readable; a
 * PDF served without ".pdf" in the path only shows up when probed). A missing
 * or unparsable URL counts as restricted. */
export function classifyUrl(url: string | null | undefined): UnreadableKind | null {
  if (!url) return "restricted";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "restricted";
  }
  if (parsed.protocol === "resource:" && /pdf\.js/i.test(url)) return "pdf";
  if (parsed.protocol === "chrome-extension:" && parsed.hostname === CHROME_PDF_VIEWER) return "pdf";
  if (/\.pdf$/i.test(parsed.pathname)) return "pdf";
  if (RESTRICTED_PROTOCOLS.has(parsed.protocol)) return "restricted";
  if (RESTRICTED_HOSTS.some((re) => re.test(parsed.hostname))) return "restricted";
  return null;
}

/** Errors meaning "no content script here and we can't inject one": no
 * receiving end, no host access, a PDF viewer or other protected page. */
export function isUnscriptableError(err: unknown): boolean {
  if (parseUnreadable(err)) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /Receiving end does not exist|Could not establish connection|No response for tab message|Cannot access|cannot be scripted|Missing host permission|Frame with ID 0 was removed|No tab with id|can't be read by the extension/i.test(
    msg,
  );
}

/** What a failed injection means for this URL: a PDF if the URL says so, else restricted. */
export function kindForUrl(url: string | null | undefined): UnreadableKind {
  return classifyUrl(url) ?? (/\/pdf(\/|$)/i.test(safePath(url)) ? "pdf" : "restricted");
}

function safePath(url: string | null | undefined): string {
  try {
    return url ? new URL(url).pathname : "";
  } catch {
    return "";
  }
}

/** Popup probe result -> kind. `pageType` is the content script's answer (null if
 * it didn't answer); `contentType` is document.contentType from an injected probe. */
export function classifyProbe(input: {
  url: string | null | undefined;
  pageType?: { pdf?: boolean } | null;
  contentType?: string | null;
  probeError?: unknown;
}): UnreadableKind | null {
  if (input.pageType?.pdf) return "pdf";
  if (input.contentType === "application/pdf") return "pdf";
  if (input.pageType || input.contentType) return null;
  if (input.probeError !== undefined && isUnscriptableError(input.probeError)) return kindForUrl(input.url);
  return null;
}
