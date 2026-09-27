// Shared helpers for the E2E suites (scripts/e2e/chrome.mjs, firefox.mjs).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value (returned) or `timeout` ms pass (throws). */
export async function waitFor(fn, { timeout = 30_000, interval = 250, what = "condition" } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t0 > timeout) throw new Error(`Timed out after ${timeout} ms waiting for ${what} (last: ${String(last)})`);
    await sleep(interval);
  }
}

/** Step runner: records pass/fail, duration and notes; never aborts the suite. */
export function makeReport(name) {
  const report = { name, started: new Date().toISOString(), steps: [], timings: {}, facts: {}, console: [], network: {} };
  async function step(title, fn) {
    const t0 = Date.now();
    const entry = { title, ok: false, ms: 0, notes: [] };
    report.steps.push(entry);
    process.stdout.write(`- ${title} … `);
    try {
      const out = await fn((n) => entry.notes.push(String(n)));
      entry.ok = true;
      if (out !== undefined) entry.result = out;
      entry.ms = Date.now() - t0;
      console.log(`ok (${entry.ms} ms)${entry.notes.length ? " — " + entry.notes.join("; ") : ""}`);
      return out;
    } catch (e) {
      entry.ms = Date.now() - t0;
      entry.error = e instanceof Error ? e.message : String(e);
      console.log(`FAIL (${entry.ms} ms): ${entry.error}`);
      return undefined;
    }
  }
  function save(file) {
    mkdirSync(dirname(file), { recursive: true });
    report.finished = new Date().toISOString();
    writeFileSync(file, JSON.stringify(report, null, 2));
  }
  return { report, step, save };
}

/**
 * Finds an element anywhere in the page, including inside CLOSED shadow
 * roots (the pill and badges use them), via CDP's pierce mode, and returns
 * the centre of its box in viewport coordinates.
 */
export async function piercedCenter(page, match) {
  const cdp = await page.createCDPSession();
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const found = [];
    const visit = (n) => {
      const attrs = {};
      for (let i = 0; i + 1 < (n.attributes?.length ?? 0); i += 2) attrs[n.attributes[i]] = n.attributes[i + 1];
      if (n.nodeType === 1 && match(n.localName, attrs)) found.push(n);
      for (const c of n.children ?? []) visit(c);
      for (const c of n.shadowRoots ?? []) visit(c);
      if (n.contentDocument) visit(n.contentDocument);
    };
    visit(root);
    const out = [];
    for (const n of found) {
      try {
        const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId: n.backendNodeId });
        const q = model.border;
        out.push({ x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4, w: model.width, h: model.height });
      } catch {
        // not rendered
      }
    }
    return out;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Text content of every node inside closed shadow roots matching `match` (CDP pierce). */
export async function piercedTexts(page, match) {
  const cdp = await page.createCDPSession();
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const texts = [];
    const textOf = (n) => (n.nodeType === 3 ? n.nodeValue : (n.children ?? []).map(textOf).join(""));
    const visit = (n) => {
      const attrs = {};
      for (let i = 0; i + 1 < (n.attributes?.length ?? 0); i += 2) attrs[n.attributes[i]] = n.attributes[i + 1];
      if (n.nodeType === 1 && match(n.localName, attrs)) texts.push(textOf(n));
      for (const c of n.children ?? []) visit(c);
      for (const c of n.shadowRoots ?? []) visit(c);
    };
    visit(root);
    return texts;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Hosts contacted, from a Chrome --log-net-log JSON file. */
export function hostsFromNetLog(json) {
  const hosts = new Map();
  let log;
  try {
    log = JSON.parse(json);
  } catch {
    // Chrome may not have finished the file (no closing brackets).
    log = JSON.parse(json.replace(/,\s*$/, "") + "]}");
  }
  for (const ev of log.events ?? []) {
    const url = ev.params?.url;
    if (typeof url !== "string") continue;
    try {
      const u = new URL(url);
      if (!/^(https?|wss?):$/.test(u.protocol)) continue;
      hosts.set(u.host, (hosts.get(u.host) ?? 0) + 1);
    } catch {
      // ignore
    }
  }
  return Object.fromEntries([...hosts.entries()].sort((a, b) => b[1] - a[1]));
}
