// Optional host permission helpers for image checks. Fetching an image's
// bytes needs host access to its origin (manifest: optional_host_permissions
// ["<all_urls>"]). Nothing is fetched without it; results say
// "permission-needed" instead.
//
// `requestImagePermission` must be called from a user gesture (popup /
// options button click); browsers reject it otherwise.

import { browser } from "wxt/browser";

/** "https://cdn.example.com/a.png" -> "https://cdn.example.com/*". */
export function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

export async function hasImagePermission(patterns: string[] = ["<all_urls>"]): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: patterns });
  } catch {
    return false;
  }
}

/** Asks for access to `patterns` (default: all sites). Call from a click handler. */
export async function requestImagePermission(patterns: string[] = ["<all_urls>"]): Promise<boolean> {
  try {
    return await browser.permissions.request({ origins: patterns });
  } catch {
    return false;
  }
}
