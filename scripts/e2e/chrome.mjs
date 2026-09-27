#!/usr/bin/env node
// Automated Chrome E2E for the extension (docs/qa.md). Loads the unpacked
// build into Chrome for Testing (Playwright's cached build) driven by
// puppeteer-core, in an isolated profile, with REAL model downloads from
// Hugging Face (cached in the profile, so reruns are fast).
//
//   npm run build:e2e && node scripts/e2e/chrome.mjs [--ext .output/chrome-mv3-e2e]
//        [--profile <dir>] [--out <report.json>] [--shots docs/screenshots] [--headed] [--quick]
//
// --quick skips binoculars and the warm re-runs.
//
// The e2e build (`wxt build --mode e2e`) only adds host access to
// http://localhost/* so image provenance can be tested without the
// optional-permission prompt (automation can't click browser prompts).
// Everything else is the production code. Native context menus can't be
// clicked either, so that step calls the same handler through the
// `__ladContextMenuSelection` hook the background exposes.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { chromium } from "playwright";
import { startServer } from "./server.mjs";
import { clickButtonByText, clickSelector, hostsFromNetLog, makeReport, piercedCenter, piercedTexts, sleep, waitFor } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const EXT = resolve(opt("--ext", ".output/chrome-mv3-e2e"));
const SCRATCH = process.env.LAD_SCRATCH ?? resolve("node_modules/.cache/lad-e2e");
const PROFILE = resolve(opt("--profile", join(SCRATCH, "chrome-profile")));
const OUT = resolve(opt("--out", join(SCRATCH, "chrome-report.json")));
const SHOTS = opt("--shots") ? resolve(opt("--shots")) : null;
const HEADED = args.includes("--headed");
const QUICK = args.includes("--quick");
// --prod: run against the production build (.output/chrome-mv3). No host
// access to the fixture server, so images must come back "permission needed".
const PROD = args.includes("--prod");
const FRESH = args.includes("--fresh");
// --no-gpu: reproduce CI's GPU-less Xvfb runner locally -- real WebGPU
// unavailability (not just the useWebGPU setting), so the engine takes the
// same device-detection + calibration path CI does.
const NO_GPU = args.includes("--no-gpu");
const NETLOG = join(SCRATCH, `chrome-netlog-${Date.now()}.json`);

if (!existsSync(join(EXT, "manifest.json"))) throw new Error(`No build at ${EXT}. Run npm run build:e2e first.`);
if (FRESH) rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
// Chrome keeps an unpacked extension's service-worker script across restarts
// while the version number is unchanged, so a rebuilt background.js would be
// ignored. Drop the SW registration + script cache (NOT CacheStorage, which
// holds the downloaded models).
for (const d of ["ScriptCache", "Database"]) rmSync(join(PROFILE, "Default", "Service Worker", d), { recursive: true, force: true });
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const { report, step, save } = makeReport("chrome");
// Safety net for the handful of top-level (non-step()) awaits below --
// mostly one-time setup, but a couple sit after many steps have already
// passed (e.g. opening the options page). Without this, an exception there
// would abort the whole process before save(OUT) runs, and CI's "upload the
// report on failure" would have nothing from a run that mostly worked.
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (err) => {
    console.error(`\n${event} outside any step:\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    report.steps.push({ title: `(crash) ${event}`, ok: false, ms: 0, notes: [], error: err instanceof Error ? err.message : String(err) });
    try {
      save(OUT);
    } catch {
      // Saving is best-effort -- don't let a save failure mask the real error.
    }
    process.exit(1);
  });
}
const srv = await startServer(0);
const BASE = `http://localhost:${srv.port}`;

const EXECUTABLE = chromium.executablePath();
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: EXECUTABLE,
    headless: !HEADED,
    pipe: true,
    enableExtensions: [EXT],
    userDataDir: PROFILE,
    defaultViewport: null,
    // Puppeteer's default is 180s. A wedged CDP call should still fail
    // faster than that (it stalls everything after it too, if the stall
    // corrupts a shared page's session) -- but CI's GPU-less runner under
    // Xvfb is genuinely slow, and legitimate calls (Page.captureScreenshot
    // while the page is busy on a CPU inference pass) were outlasting the
    // 60s this used to be. 120s: still well short of the default, generous
    // enough for CI.
    protocolTimeout: 120_000,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1100,800",
      `--log-net-log=${NETLOG}`,
      "--net-log-capture-mode=Default",
      // GitHub Actions' Ubuntu runners restrict unprivileged user
      // namespaces (AppArmor), which Chrome's sandbox needs; without this
      // Chrome exits within milliseconds of launch and puppeteer.launch()
      // rejects before a single step has run (see browser-t7-calibration.mjs,
      // which hit the same thing).
      ...(process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
      // --no-gpu: match CI's runner -- no real GPU, so navigator.gpu never
      // resolves an adapter (src/engine/runtime.ts) and the engine falls
      // back to WASM the same way it would there, regardless of the
      // useWebGPU setting.
      ...(NO_GPU ? ["--disable-gpu", "--disable-software-rasterizer", "--disable-features=WebGPU"] : []),
    ],
  });
} catch (e) {
  console.error(
    `\nChrome failed to launch.\n  executablePath: ${EXECUTABLE} (exists: ${existsSync(EXECUTABLE)})\n  extension dir: ${EXT} (exists: ${existsSync(EXT)})\n  profile dir: ${PROFILE}\n  CI: ${!!process.env.CI}\n  error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
}
report.facts.browserVersion = await browser.version();

// ---- console capture from every context (pages, service worker, offscreen doc) ----
const consoleLog = report.console;
function watchTarget(t) {
  const url = t.url();
  const label = url.startsWith("chrome-extension://") ? url.replace(/^chrome-extension:\/\/[^/]+/, "ext:") : url;
  const attach = (obj) =>
    obj?.on?.("console", (m) => {
      if (m.type() === "error" || m.type() === "warn" || m.type() === "warning")
        consoleLog.push({ ctx: label, type: m.type(), text: m.text().slice(0, 400) });
    });
  if (t.type() === "service_worker") t.worker().then(attach).catch(() => {});
  else if (t.type() === "page" || t.type() === "other" || t.type() === "background_page")
    t.asPage?.()
      .then((p) => {
        attach(p);
        p.on("pageerror", (e) => consoleLog.push({ ctx: label, type: "pageerror", text: String(e).slice(0, 400) }));
      })
      .catch(() => {});
}
browser.targets().forEach(watchTarget);
browser.on("targetcreated", watchTarget);

const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"));
const EXT_ORIGIN = swTarget.url().match(/^chrome-extension:\/\/[^/]+/)[0];
let sw = await swTarget.worker();
report.facts.extensionOrigin = EXT_ORIGIN;

/**
 * `swEval()`, refreshing the service-worker handle first if Chrome
 * already terminated it (MV3 workers go idle after ~30s; a run with long
 * gaps between background calls -- e.g. around a slow analysis -- can hit
 * this). Every background call in this file goes through here instead of
 * `sw.evaluate` directly.
 */
async function swEval(fn, ...args) {
  try {
    return await sw.evaluate(fn, ...args);
  } catch (e) {
    if (!/detached frame or worker|Session closed|Target closed/i.test(String(e))) throw e;
    const t = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 10_000 });
    sw = await t.worker();
    return await sw.evaluate(fn, ...args);
  }
}

const openOrder = []; // URLs in the order newTab opened them
async function newTab(url, viewport = { width: 1000, height: 720 }) {
  openOrder.push(url);
  const p = await browser.newPage();
  await p.setViewport(viewport);
  await p.goto(url, { waitUntil: "load" });
  return p;
}
async function tabIdOf(url) {
  const byUrl = await swEval(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
  if (byUrl !== undefined) return byUrl;
  // The production build has no "tabs" permission or host access to the
  // fixture server, so tab URLs are hidden: fall back to creation order (tab
  // ids increase; the first tab is the browser's initial blank page).
  const ids = await swEval(async () => (await chrome.tabs.query({})).map((t) => t.id).sort((a, b) => a - b));
  const i = openOrder.indexOf(url);
  return i >= 0 ? ids[i + 1] : undefined;
}
/** Sends a typed request envelope from an extension page (src/shared/messages.ts wire format). */
async function ext(page, type, payload) {
  const res = await page.evaluate(
    (type, payload) =>
      chrome.runtime.sendMessage({ kind: "request", id: `e2e-${Math.random()}`, type, payload }),
    type,
    payload,
  );
  if (!res) throw new Error(`no response to ${type}`);
  if (!res.ok) throw new Error(`${type}: ${res.error}`);
  return res.payload;
}
async function shot(page, name, opts = {}) {
  if (!SHOTS) return;
  try {
    await page.screenshot({ path: join(SHOTS, name), type: name.endsWith(".png") ? "png" : "jpeg", quality: name.endsWith(".png") ? undefined : 70, ...opts });
  } catch (e) {
    // Screenshots are diagnostic, not assertions -- on a slow, GPU-less CI
    // runner under Xvfb, Page.captureScreenshot can occasionally outlast
    // even a generous protocolTimeout while the page is busy on a CPU
    // inference pass. Don't fail a step (or the run) over a missing picture.
    console.warn(`[shot] ${name} failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}
const highlightCount = (page) =>
  page.evaluate(() => [...CSS.highlights.keys()].filter((k) => k.startsWith("ai-detector-hl")).reduce((n, k) => n + CSS.highlights.get(k).size, 0));
const highlightNames = (page) => page.evaluate(() => [...CSS.highlights.keys()].filter((k) => k.startsWith("ai-detector-hl") && CSS.highlights.get(k).size));
/** Merges a partial Settings object into storage.sync from the service worker (an extension context; fixture pages have no chrome.* APIs). */
const mergeSettings = (partial) =>
  swEval(async (partial) => {
    const cur = (await chrome.storage.sync.get("settings")).settings ?? {};
    await chrome.storage.sync.set({ settings: { ...cur, ...partial } });
  }, partial);
const getStoredSettings = () => swEval(async () => (await chrome.storage.sync.get("settings")).settings ?? null);

// Mirrors src/shared/settings.ts's PRESENCE_PRESETS: the app itself reads
// settings.autoRunPolicy/settings.surfaces, not settings.presence, to decide
// what shows on a page -- `presence` is just the preset's label. Merging only
// `{ presence }` leaves autoRunPolicy/surfaces at whatever a previous step
// set them to, which silently breaks the very behaviour a "switch preset"
// step means to test. setPresence() always applies the full preset.
const PRESENCE_PRESETS = {
  onClick: { autoRunPolicy: "never", surfaces: { popup: true, badge: false, chip: false, highlights: false, sidePanel: false } },
  badge: { autoRunPolicy: "always", surfaces: { popup: true, badge: true, chip: false, highlights: false, sidePanel: false } },
  statusChip: { autoRunPolicy: "always", surfaces: { popup: true, badge: true, chip: true, highlights: false, sidePanel: false } },
  inspector: { autoRunPolicy: "always", surfaces: { popup: true, badge: true, chip: false, highlights: true, sidePanel: false } },
  sidePanel: { autoRunPolicy: "always", surfaces: { popup: true, badge: true, chip: false, highlights: false, sidePanel: true } },
};
const setPresence = (presence, extra = {}) => mergeSettings({ presence, ...PRESENCE_PRESETS[presence], ...extra });

// ---------------------------------------------------------------------------

await step("presence: force Inspector for the fixture suite below (docs/plan.md 'T9' -- default is Status chip)", async (note) => {
  // The pill/highlight assertions in this file predate presence modes and
  // test the Inspector surface set specifically (pill + highlights whenever
  // an analysis runs). The shipped *default* preset is "Status chip" (chip
  // only, no auto pill/highlights) -- covered by the dedicated "presence
  // modes" steps near the end of this file instead of changing the product
  // default. autoRunPolicy stays "never": this suite triggers every analysis
  // itself (popup clicks, direct analyzeTab calls); autoRun firing on its own
  // on every page load would race the suite's own popup-driven mode changes
  // (the popup reactively shows a progress screen -- no mode <select> -- for
  // ANY analysis on its tab, including one autoRun started).
  await setPresence("inspector", { autoRunPolicy: "never", ...(NO_GPU ? { useWebGPU: false } : {}) });
  note(`presence -> inspector (surfaces.highlights: true), autoRun off, for this run${NO_GPU ? "; useWebGPU: false (--no-gpu)" : ""}`);
});
const pages = {};
await step("open fixture pages (news, blog, spa, demo)", async (note) => {
  for (const name of ["news", "blog", "spa", "demo"]) {
    pages[name] = await newTab(`${BASE}/${name}.html`);
  }
  // The content script's pill region is present on every page under Inspector,
  // regardless of its current state (idle/analyzing/done) -- with a consented,
  // already-cached profile (a rerun) autoRun (autoRunPolicy: "always") can
  // race past the idle "Scan page" button before this check runs, so this
  // checks the pill's own state-independent region rather than that one button.
  const pill = await waitFor(() => piercedCenter(pages.news, (tag, a) => a.role === "region" && a["aria-label"] === "AI text detector"), {
    timeout: 5000,
    what: "pill region",
  });
  if (!pill.length) throw new Error("pill region not found");
  note(`pill visible at ${Math.round(pill[0].x)},${Math.round(pill[0].y)}`);
});

const newsTabId = await tabIdOf(`${BASE}/news.html`);
const popup = await newTab(`${EXT_ORIGIN}/popup.html?tabId=${newsTabId}`, { width: 380, height: 620 });
await popup.evaluate(() => {
  window.__ev = [];
  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.event === "analysisStatus")
      window.__ev.push({ t: Date.now(), tab: m.tabId, s: m.status.state, p: m.status.progress?.phase, l: m.status.progress?.loaded, tot: m.status.progress?.total });
  });
});

await step("popup: consent screen, then 'Download & enable'", async (note) => {
  const settings = await popup.evaluate(async () => (await chrome.storage.sync.get("settings")).settings ?? null);
  if (settings?.consentedDownload) {
    note("already consented in this profile (models cached from an earlier run)");
    return;
  }
  await popup.waitForSelector("button::-p-text(Download & enable)", { timeout: 5000 });
  await shot(popup, "popup-consent.png");
  await clickButtonByText(popup, "Download & enable");
  // "Download & enable" now fetches every checked model for real (text
  // detectors + the default voice model, several hundred MB combined) before
  // the popup leaves the checklist screen -- not the near-instant flag flip
  // this wait used to assume. Give it the same generous budget as a cold
  // analysis below. Puppeteer's own waitForSelector blocks on a single CDP
  // call for as long as it takes, which the browser's `protocolTimeout`
  // (60s, set on launch to fail a truly wedged call fast) would cut off long
  // before a real multi-hundred-MB download on a fresh profile finishes --
  // poll instead, like every other long wait in this file, so each round
  // trip is short and only the total budget is generous.
  await waitFor(async () => popup.$$eval("button", (els) => els.some((b) => b.textContent?.includes("Analyze page"))), {
    timeout: 20 * 60_000,
    interval: 1000,
    what: "'Analyze page' after the first-run download",
  });
});

async function setMode(mode) {
  await popup.select('select[aria-label="Detector mode"]', mode);
  await waitFor(async () => (await popup.evaluate(async () => (await chrome.storage.sync.get("settings")).settings?.mode)) === mode, {
    what: `mode ${mode}`,
  });
  await sleep(400); // the popup re-renders on the settings change
}

async function analyzeViaPopup(mode, label) {
  await setMode(mode);
  await popup.evaluate(() => (window.__ev = []));
  const t0 = Date.now();
  await clickButtonByText(popup, "Analyze page");
  // Wait for a result finished after this click (the previous run's "done"
  // status is still there until the new run starts).
  const status = await waitFor(
    async () => {
      const s = await ext(popup, "getTabStatus", { tabId: newsTabId });
      if (s.state === "error") return s;
      return s.state === "done" && s.finishedAt >= t0 && s.mode === mode ? s : null;
    },
    { timeout: 20 * 60_000, interval: 500, what: `${mode} analysis` },
  );
  const t1 = Date.now();
  if (status.state === "error") throw new Error(status.error);
  const ev = await popup.evaluate(() => window.__ev.filter((e) => e.s === "running"));
  const dl = ev.filter((e) => e.p === "download");
  const firstLoad = ev.find((e) => e.p === "load")?.t;
  const firstAnalyze = ev.find((e) => e.p === "analyze")?.t ?? t1;
  const bytes = Math.max(0, ...dl.map((e) => e.tot ?? 0));
  const loadStart = dl.length ? dl[dl.length - 1].t : (firstLoad ?? firstAnalyze);
  const timing = {
    totalMs: t1 - t0,
    downloadMs: dl.length ? dl[dl.length - 1].t - dl[0].t : 0,
    downloadBytes: bytes,
    loadMs: firstAnalyze - loadStart,
    analyzeMs: t1 - firstAnalyze,
  };
  report.timings[label] = timing;
  const r = status.result;
  return {
    overall: +r.overall.toFixed(3),
    sentences: r.sentences.length,
    flagged: r.sentences.filter((s) => s.score >= 0.5).length,
    scores: r.sentences.map((s) => s.score),
    notes: r.notes,
    timing,
  };
}

const MODES = ["ensemble", "classifier", "classifierLite", "perplexity", ...(QUICK ? [] : ["binoculars"])];
const modeResults = {};
for (const mode of MODES) {
  modeResults[mode] = await step(`analyze news page via popup — ${mode} (cold)`, async (note) => {
    const r = await analyzeViaPopup(mode, `${mode}-cold`);
    note(`overall ${r.overall}, ${r.flagged}/${r.sentences} flagged, total ${r.timing.totalMs} ms (download ${r.timing.downloadMs} ms / ${(r.timing.downloadBytes / 1e6).toFixed(0)} MB, load ${r.timing.loadMs} ms, analyze ${r.timing.analyzeMs} ms)`);
    // renderHighlights is sent right after the "done" status; give it a moment.
    const n = await waitFor(() => highlightCount(pages.news), { timeout: 5000, what: "highlights" });
    const distinct = new Set(r.scores.map((x) => x.toFixed(4))).size;
    note(`${distinct} distinct sentence scores`);
    if (distinct < 2 && r.sentences > 5) throw new Error(`degenerate scores: every sentence scored ${r.scores[0]}`);
    note(`${n} highlight ranges in page`);
    if (mode === "ensemble") await shot(popup, "popup-result.png");
    return r;
  });
}
report.facts.modeResults = modeResults;

if (!QUICK) {
  // Models are now loaded. Analyze a page not seen yet in this mode (the
  // engine caches results per text), so this is load-free, compute-only time.
  const blogTab = await tabIdOf(`${BASE}/blog.html`);
  for (const mode of MODES) {
    await step(`analyze blog page — ${mode} (warm: models already loaded)`, async (note) => {
      await setMode(mode);
      const t0 = Date.now();
      const r = await ext(popup, "analyzeTab", { tabId: blogTab, target: "page" });
      const ms = Date.now() - t0;
      report.timings[`${mode}-warm`] = { totalMs: ms, sentences: r.sentences.length };
      note(`overall ${r.overall.toFixed(3)}, ${r.sentences.length} sentences, ${ms} ms`);
    });
  }
}

await step("engine info (device, threads, crossOriginIsolated, cache)", async (note) => {
  const info = await ext(popup, "getEngineInfo", undefined);
  report.facts.engineInfo = info.runtime;
  note(JSON.stringify(info.runtime));
  if (!info.runtime) throw new Error("no runtime info");
  if (!info.runtime.crossOriginIsolated) throw new Error("offscreen document is not crossOriginIsolated");
});

// Finish on ensemble so the screenshots show the default mode. Through
// step() (not a bare top-level await) like everything else here: an
// uncaught exception at module top level would abort the whole run before
// save(OUT) below ever runs, losing the report for every step that already
// passed.
await step("reset to ensemble mode for the screenshots below", async () => {
  await setMode("ensemble");
  await ext(popup, "analyzeTab", { tabId: newsTabId, target: "page" });
});

/** Share of sentences flagged in paragraphs labelled data-src="human" / "ai" (fixture ground truth). */
async function flagRates(page) {
  return page.evaluate(() => {
    const groups = [...CSS.highlights.keys()].filter((k) => k.startsWith("ai-detector-hl") && CSS.highlights.get(k).size);
    const labelOf = (r) => r.startContainer.parentElement?.closest("[data-src]")?.getAttribute("data-src") ?? "none";
    const out = {};
    for (const k of groups) {
      // Bucket index -> score range; flagged = bucket at/above the 0.5 threshold.
      const m = /-(n|m)(\d+)$/.exec(k);
      const bucket = m ? Number(m[2]) : 0;
      for (const r of CSS.highlights.get(k)) {
        const lab = labelOf(r);
        const o = (out[lab] ??= { sentences: 0, flagged: 0 });
        o.sentences++;
        if (bucket >= 6) o.flagged++; // 12 buckets: 6 = [0.5, 0.58)
      }
    }
    for (const o of Object.values(out)) o.rate = +(o.flagged / o.sentences).toFixed(2);
    return out;
  });
}

await step("per-paragraph flag rates on labelled fixtures (ensemble, default device)", async (note) => {
  await setMode("ensemble");
  const rates = {};
  for (const name of ["news", "blog"]) {
    const id = await tabIdOf(`${BASE}/${name}.html`);
    await popup.select('select[aria-label="Highlight style"]', "heatmap");
    await ext(popup, "analyzeTab", { tabId: id, target: "page" });
    await sleep(500);
    rates[name] = await flagRates(pages[name]);
    note(`${name}: human ${JSON.stringify(rates[name].human)}, ai ${JSON.stringify(rates[name].ai)}, unlabelled ${JSON.stringify(rates[name].none ?? {})}`);
    // Pill and popup must report the same flagged count (same data).
    const pill = (await piercedTexts(pages[name], (tag, a) => a.role === "region" && a["aria-label"] === "AI text detector")).join(" ");
    const pillN = Number(/(\d+) flagged/.exec(pill)?.[1]);
    const st = await ext(popup, "getTabStatus", { tabId: id });
    const popupN = st.result.sentences.filter((x) => x.score >= 0.5).length;
    note(`${name}: pill ${pillN} flagged, popup ${popupN}/${st.result.sentences.length}`);
    if (pillN !== popupN) throw new Error(`${name}: pill says ${pillN} flagged, popup ${popupN}`);
  }
  report.facts.flagRates = rates;
  const bad = [];
  for (const [name, r] of Object.entries(rates)) {
    // blog.html's AI text is in the reader comments, outside <article>, which
    // a page scan deliberately doesn't read (the article is the page's text).
    if (!r.human) bad.push(`${name}: no labelled human paragraphs analysed`);
    else if (!r.ai) {
      if (r.human.rate > 0.2) bad.push(`${name}: ${Math.round(r.human.rate * 100)}% of human sentences flagged`);
    } else {
      if (r.human.rate > 0.2) bad.push(`${name}: ${Math.round(r.human.rate * 100)}% of human sentences flagged`);
      if (r.ai.rate <= r.human.rate) bad.push(`${name}: AI paragraphs not flagged more than human ones`);
    }
    if (r.none?.flagged) bad.push(`${name}: ${r.none.flagged} flagged sentences outside labelled paragraphs (headline/byline/caption?)`);
  }
  if (bad.length) throw new Error(bad.join("; "));
});

await step("highlight styles switch live (heatmap -> flagged -> underline -> heatmap)", async (note) => {
  await pages.news.bringToFront();
  await pages.news.evaluate(() => window.scrollTo(0, 0));
  for (const style of ["heatmap", "flagged", "underline", "heatmap"]) {
    await popup.select('select[aria-label="Highlight style"]', style);
    const names = await waitFor(
      async () => {
        const n = await highlightNames(pages.news);
        return (n.length || style === "flagged") && n.every((k) => k.includes(`-${style}-`)) ? n : null;
      },
      { timeout: 5000, what: `${style} highlights` },
    );
    note(`${style}: ${names.length} highlight groups`);
    await shot(pages.news, `page-${style}.jpg`);
  }
});

await step("pill: done state, ▼/▲ step through flagged sentences", async (note) => {
  const texts = await piercedTexts(pages.news, (tag, a) => a.role === "region" && a["aria-label"] === "AI text detector");
  note(`pill: ${texts.join(" ").replace(/\s+/g, " ").slice(0, 120)}`);
  const next = await piercedCenter(pages.news, (tag, a) => tag === "button" && a["aria-label"] === "Next flagged sentence");
  if (!next.length) throw new Error("no ▼ button (0 flagged sentences?)");
  const y0 = await pages.news.evaluate(() => window.scrollY);
  await pages.news.mouse.click(next[0].x, next[0].y);
  await sleep(900);
  const y1 = await pages.news.evaluate(() => window.scrollY);
  await pages.news.mouse.click(next[0].x, next[0].y);
  await sleep(900);
  const counter = await piercedTexts(pages.news, (tag, a) => a["data-role"] === "counter");
  note(`scrollY ${y0} -> ${y1}; counter "${counter.join("")}"`);
  await shot(pages.news, "page-pill-nav.jpg");
  const prev = await piercedCenter(pages.news, (tag, a) => tag === "button" && a["aria-label"] === "Previous flagged sentence");
  await pages.news.mouse.click(prev[0].x, prev[0].y);
  await sleep(500);
  const counter2 = await piercedTexts(pages.news, (tag, a) => a["data-role"] === "counter");
  note(`after ▲: "${counter2.join("")}"`);
});

await step("hidden-Unicode markers (zero-width + tag characters)", async (note) => {
  const markers = await pages.news.evaluate(() => [...document.querySelectorAll(".ai-detector-unicode-marker")].map((m) => m.textContent));
  note(`markers: ${markers.join(" ")}`);
  if (!markers.some((m) => m.includes("ZW")) || !markers.some((m) => m.includes("TAG"))) throw new Error("expected ZW and TAG markers");
  const broken = await pages.news.evaluate(() => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(document.body.innerText));
  if (broken) throw new Error("a marker split a surrogate pair");
});

await step("image provenance on the news page (badges + popup summary)", async (note) => {
  const status = await waitFor(
    async () => {
      const s = await ext(popup, "getTabStatus", { tabId: newsTabId });
      return s.state === "done" && s.result.images && s.result.images.total >= 4 ? s : null;
    },
    { timeout: 60_000, what: "image summary" },
  );
  report.facts.imageSummary = status.result.images;
  note(JSON.stringify(status.result.images));
  const badges = await piercedTexts(pages.news, (tag, a) => tag === "button" && /\bbadge\b/.test(a.class ?? ""));
  note(`badges: ${badges.join(" | ")}`);
  report.facts.imageBadges = badges;
  const s = status.result.images;
  const problems = [];
  if (PROD) {
    if (s.checked !== 0 || !s.permissionNeeded.some((p) => p.includes("localhost"))) problems.push("production build fetched images without permission");
    await shot(popup, "popup-images-permission.png", { fullPage: true });
    if (problems.length) throw new Error(problems.join("; "));
    note("production build: nothing fetched, per-site permission requested");
    return;
  }
  if (s.withCredentials < 1) problems.push("no C2PA image");
  if (s.withWatermark < 1) problems.push("no SD watermark");
  if (s.withUnsignedClaim < 1) problems.push("no unsigned metadata claim");
  if (!s.permissionNeeded.some((p) => p.includes("127.0.0.1"))) problems.push("cross-origin image didn't ask for permission");
  const c2paErr = consoleLog.filter((c) => /c2pa|worker/i.test(c.text));
  if (c2paErr.length) note(`c2pa-related console: ${c2paErr.map((c) => c.text).join(" / ").slice(0, 300)}`);
  await pages.news.evaluate(() => document.querySelector('img[src="/img/c2pa.jpg"]').scrollIntoView({ block: "center" }));
  await sleep(400);
  await shot(pages.news, "page-image-badges.jpg");
  await popup.setViewport({ width: 380, height: 820 });
  await popup.reload();
  await sleep(1200);
  await shot(popup, "popup-images.png", { fullPage: true });
  await popup.setViewport({ width: 380, height: 620 });
  if (problems.length) throw new Error(problems.join("; "));
});

if (!PROD) await step("C2PA details (c2pa-web worker ran in the offscreen document)", async (note) => {
  const res = await swEval(async (src) => {
    const r = await chrome.runtime.sendMessage({ kind: "request", id: "x", type: "provenanceHostAnalyze", payload: { images: [{ src }] } });
    return r;
  }, `${BASE}/img/c2pa.jpg`);
  const r = res?.payload?.results?.[0];
  if (!r) throw new Error(`no result: ${JSON.stringify(res).slice(0, 300)}`);
  note(`status ${r.status}; c2pa check ${r.checks.c2pa}; signer ${r.c2pa?.signer}; state ${r.c2pa?.validationState}; trusted ${r.c2pa?.trusted}; failures ${r.c2pa?.failures?.join(",")}`);
  report.facts.c2paResult = { checks: r.checks, c2pa: r.c2pa, errors: r.errors };
  if (r.checks.c2pa !== "found") throw new Error(`c2pa check: ${r.checks.c2pa} ${r.errors.join("; ")}`);
});

await step("pill ✕ clears highlights, markers and badges", async (note) => {
  const x = await piercedCenter(pages.news, (tag, a) => tag === "button" && a["aria-label"] === "Clear all highlights");
  await pages.news.mouse.click(x[0].x, x[0].y);
  await sleep(500);
  const n = await highlightCount(pages.news);
  const markers = await pages.news.evaluate(() => document.querySelectorAll(".ai-detector-unicode-marker").length);
  const badges = await piercedTexts(pages.news, (tag, a) => tag === "button" && /\bbadge\b/.test(a.class ?? ""));
  note(`highlights ${n}, markers ${markers}, badges ${badges.length}`);
  if (n || markers || badges.length) throw new Error("something survived the clear");
});

await step("pill 'Scan page' runs the same background path", async (note) => {
  await pages.blog.bringToFront();
  // The blog already shows results from the warm runs: clear, then scan.
  const clear = await piercedCenter(pages.blog, (tag, a) => tag === "button" && a["aria-label"] === "Clear all highlights");
  if (clear.length) await pages.blog.mouse.click(clear[0].x, clear[0].y);
  await sleep(300);
  const run = await piercedCenter(pages.blog, (tag, a) => tag === "button" && a["aria-label"] === "Scan this page for AI-written text");
  await pages.blog.mouse.click(run[0].x, run[0].y);
  const blogTab = await tabIdOf(`${BASE}/blog.html`);
  const s = await waitFor(
    async () => {
      const st = await ext(popup, "getTabStatus", { tabId: blogTab });
      return st.state === "done" || st.state === "error" ? st : null;
    },
    { timeout: 120_000, what: "pill analysis" },
  );
  if (s.state === "error") throw new Error(s.error);
  note(`blog overall ${s.result.overall.toFixed(3)}; highlights ${await highlightCount(pages.blog)}`);
  await shot(pages.blog, "page-blog-pill.jpg");
});

await step("context menu 'Check selected text' (same handler, via hook)", async (note) => {
  await pages.spa.bringToFront();
  await waitFor(() => pages.spa.evaluate(() => !!document.querySelector("article p")), { what: "spa content" });
  await pages.spa.evaluate(() => {
    const p = document.querySelectorAll("article p")[1];
    const r = document.createRange();
    r.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  const spaTab = await tabIdOf(pages.spa.url());
  await swEval((id) => globalThis.__ladContextMenuSelection(id), spaTab);
  const s = await ext(popup, "getTabStatus", { tabId: spaTab });
  if (s.state !== "done") throw new Error(`state ${s.state} ${s.error ?? ""}`);
  const blocks = new Set(s.result.sentences.map((x) => x.blockId));
  note(`selection: ${s.result.sentences.length} sentences in ${blocks.size} block(s), overall ${s.result.overall.toFixed(3)}; highlights ${await highlightCount(pages.spa)}`);
  if (blocks.size !== 1) throw new Error("selection analysis should produce exactly one block");
  // A selection inside ONE text node (regression: used to extract nothing).
  await pages.spa.evaluate(() => {
    const t = document.querySelectorAll("article p")[0].firstChild;
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(t, Math.min(t.data.length, 400));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await swEval((id) => globalThis.__ladContextMenuSelection(id), spaTab);
  const s2 = await ext(popup, "getTabStatus", { tabId: spaTab });
  if (s2.state !== "done") throw new Error(`single-text-node selection: ${s2.state} ${s2.error ?? ""}`);
  note(`single-text-node selection: ${s2.result.sentences.length} sentences`);
});

await step("SPA client-side navigation clears highlights", async (note) => {
  await pages.spa.evaluate(() => document.querySelector('nav a[data-a="ai"]').click());
  await sleep(1200);
  const n = await highlightCount(pages.spa);
  const pill = await piercedTexts(pages.spa, (tag, a) => a.role === "region" && a["aria-label"] === "AI text detector");
  note(`highlights after pushState: ${n}; pill: ${pill.join(" ").replace(/\s+/g, " ").slice(0, 80)}`);
  if (n) throw new Error("stale highlights after SPA navigation");
});

if (!PROD) await step("classifier vs lite on fixture pages (overall scores)", async (note) => {
  const out = {};
  const targets = {
    "blog (human NPS/USGS + 2 AI comments)": `${BASE}/blog.html`,
    "news (mixed human/AI)": `${BASE}/news.html`,
    "spa ai article": `${BASE}/spa.html?a=ai`,
    "spa human article": `${BASE}/spa.html?a=human`,
    "demo.html (T2 demo)": `${BASE}/demo.html`,
  };
  const p = await newTab(`${BASE}/blog.html`);
  for (const [label, url] of Object.entries(targets)) {
    await p.goto(url, { waitUntil: "load" });
    await sleep(600);
    const id = await tabIdOf(p.url());
    out[label] = {};
    for (const mode of ["classifier", "classifierLite", "perplexity", "ensemble"]) {
      await setMode(mode);
      const r = await ext(popup, "analyzeTab", { tabId: id, target: "page" });
      out[label][mode] = +r.overall.toFixed(3);
    }
    note(`${label}: ${JSON.stringify(out[label])}`);
  }
  await setMode("ensemble");
  report.facts.fixtureScores = out;
  await p.close();
});

if (!PROD) await step("WebGPU vs WASM (settings.useWebGPU) on the same pages", async (note) => {
  const out = {};
  const p = await newTab(`${BASE}/spa.html?a=ai`);
  const setGpu = (on) =>
    popup.evaluate(async (on) => {
      const s = (await chrome.storage.sync.get("settings")).settings;
      await chrome.storage.sync.set({ settings: { ...s, useWebGPU: on } });
    }, on);
  for (const url of [`${BASE}/spa.html?a=ai`, `${BASE}/spa.html?a=human`, `${BASE}/news.html`]) {
    await p.goto(url, { waitUntil: "load" });
    await sleep(600);
    const id = await tabIdOf(p.url());
    const row = (out[url.replace(BASE + "/", "")] = {});
    for (const mode of ["classifier", "classifierLite", "perplexity"]) {
      await setMode(mode);
      for (const gpu of [true, false]) {
        await setGpu(gpu);
        const t0 = Date.now();
        const r = await ext(popup, "analyzeTab", { tabId: id, target: "page" });
        row[`${mode}-${gpu ? "webgpu" : "wasm"}`] = { overall: +r.overall.toFixed(3), ms: Date.now() - t0 };
      }
    }
    note(`${url.replace(BASE + "/", "")}: ${Object.entries(row).map(([k, v]) => `${k} ${v.overall}`).join(", ")}`);
  }
  const info = await ext(popup, "getEngineInfo", undefined);
  note(`device after useWebGPU=false: ${info.runtime.device}`);
  await setGpu(false); // back to the default
  await setMode("ensemble");
  report.facts.deviceComparison = out;
  await p.close();
  if (info.runtime.device !== "wasm") throw new Error("useWebGPU=false did not switch to WASM");
});

// ---- options page ----
const options = await newTab(`${EXT_ORIGIN}/options.html`, { width: 1000, height: 900 });
await step("options: renders, engine line, cache sizes", async (note) => {
  await options.waitForSelector("::-p-text(Total model cache)");
  await sleep(1500);
  const line = await options.$eval(".status-line", (e) => e.textContent);
  const total = await options.$eval(".cache-total .value", (e) => e.textContent).catch(() => "?");
  note(`${line} · cache ${total}`);
  await shot(options, "options.jpg", { fullPage: false });
});

await step("options: Check for updates", async (note) => {
  await clickButtonByText(options, "Check for updates");
  await waitFor(async () => !(await options.$("::-p-text(Checking Hugging Face)")), { timeout: 60_000, what: "update check" });
  const errs = await options.$$eval(".model-error-note", (els) => els.map((e) => e.textContent));
  const upd = await options.$$eval(".model-update-note", (els) => els.map((e) => e.textContent));
  note(`updates: ${upd.length ? upd.join(" | ") : "none (all pinned revisions current)"}${errs.length ? `; errors: ${errs.join(" | ")}` : ""}`);
  const last = await ext(options, "getEngineInfo", undefined);
  if (!last.lastUpdateCheck) throw new Error("no lastUpdateCheck recorded");
});

await step("options: custom-model validation (open licence / no licence / missing repo)", async (note) => {
  const cases = [
    ["classifier", "onnx-community/roberta-base-openai-detector-ONNX"],
    ["classifier", "onnx-community/chatgpt-detector-roberta-ONNX"],
    ["perplexityLM", "Xenova/gpt2"],
    ["classifier", "this-org-does-not-exist-xyz/nothing"],
  ];
  const out = [];
  for (const [slot, repo] of cases) {
    const v = await ext(options, "validateCustomModel", { slot, repo });
    out.push({ slot, repo, ...v });
    note(`${repo}: ${v.ok ? `ok, licence ${v.license}, open=${v.openLicense}, ${v.warnings.length} warnings${v.warnings.length ? ` (${v.warnings.join(" / ").slice(0, 160)})` : ""}` : `rejected: ${v.error}`}`);
  }
  report.facts.customModelValidation = out;
  if (!out[0].ok || !out[0].openLicense) throw new Error("known-good MIT repo should validate as open");
  if (out[1].ok && out[1].openLicense) throw new Error("unlicensed repo should not count as open");
  if (out[3].ok) throw new Error("missing repo should fail");
  // UI path for one of them, for the screenshot.
  const input = await options.$('input[placeholder^="org/model-name"]');
  await input.type("onnx-community/chatgpt-detector-roberta-ONNX");
  const btns = await options.$$("button::-p-text(Check licence)");
  await btns[0].evaluate((el) => el.click());
  await waitFor(async () => !(await options.$("::-p-text(Checking…)")), { what: "validation UI" });
  await sleep(300);
  const el = await options.$(".license-warning, .model-error-note");
  if (el) await el.scrollIntoView();
  await shot(options, "options-custom-model.jpg");
});

// ---- T12a: presence modes, chip, slop filter, toasts, checklist, new entry points ----

await step("options: model download checklist (checkbox toggles fusion.detectors, running total)", async (note) => {
  await mergeSettings({ mode: "ensemble" });
  await options.reload();
  await options.waitForSelector("::-p-text(Download checklist)");
  const rowsBefore = await options.$$eval(".model-checklist-row", (els) => els.length);
  const totalBefore = await options.$eval(".model-checklist-footer .value", (e) => e.textContent);
  note(`${rowsBefore} rows, total ${totalBefore}`);
  // Uncheck a non-locked detector row (Fusion's default set is 2, so this never hits the "keep at least one" floor).
  // Every click re-renders the whole options page (clearChildren + rebuild), detaching prior element handles,
  // so the checkbox is re-queried fresh each time rather than reusing one handle.
  const checkableSelector = ".model-checklist-row input[type=checkbox]:not([disabled])";
  if (!(await options.$(checkableSelector))) throw new Error("no uncheckable checklist row (mode has only one detector?)");
  await clickSelector(options, checkableSelector);
  await waitFor(async () => (await options.$eval(".model-checklist-footer .value", (e) => e.textContent)) !== totalBefore, {
    what: "checklist total to change after unchecking a row",
  });
  const totalAfter = await options.$eval(".model-checklist-footer .value", (e) => e.textContent);
  note(`after unchecking one row: total ${totalAfter}`);
  await shot(options, "options-checklist.jpg");
  await clickSelector(options, checkableSelector); // put it back for later steps (the same selector now matches the same still-unchecked row)
  await waitFor(async () => (await options.$eval(".model-checklist-footer .value", (e) => e.textContent)) === totalBefore, { what: "checklist total restored" });
});

await step("toasts: 'Analyze selection' dims with no selection, toasts instead of erroring", async (note) => {
  await pages.spa.bringToFront();
  await pages.spa.evaluate(() => getSelection().removeAllRanges());
  const spaTabId = await tabIdOf(pages.spa.url());
  // A dedicated popup instance pinned to the SPA tab, rather than
  // re-navigating the suite's shared `popup` (opened once, pinned to the
  // news tab, at the top of this file): re-navigating that long-lived page
  // via goto()/location.search here has been observed to wedge its CDP
  // session for the rest of the run (every later call on it then hangs
  // until Puppeteer's protocolTimeout). A fresh page behaves like a real
  // popup actually does -- a new one each time it's opened.
  let spaPopup = await newTab(`${EXT_ORIGIN}/popup.html?tabId=${spaTabId}`, { width: 380, height: 620 });
  await spaPopup.waitForSelector("button::-p-text(Analyze page)");
  await sleep(400); // popup's getSelectionInfo round-trip to the content script
  const dimmed = await spaPopup.$eval("button::-p-text(Selection)", (b) => ({ ariaDisabled: b.getAttribute("aria-disabled"), title: b.title }));
  note(`Selection button: aria-disabled=${dimmed.ariaDisabled}, title="${dimmed.title}"`);
  if (dimmed.ariaDisabled !== "true" || dimmed.title !== "Select text first") throw new Error("Selection button should be dimmed with a tooltip when nothing is selected");
  const stateBefore = await ext(spaPopup, "getTabStatus", { tabId: spaTabId });
  await clickButtonByText(spaPopup, "Selection");
  await spaPopup.waitForSelector(".lad-toast.is-visible", { timeout: 3000 });
  const toastText = await spaPopup.$eval(".lad-toast", (e) => e.textContent);
  note(`toast: "${toastText}"`);
  if (toastText !== "No text selected") throw new Error(`unexpected toast text: "${toastText}"`);
  await shot(spaPopup, "popup-toast.png");
  const stateAfter = await ext(spaPopup, "getTabStatus", { tabId: spaTabId });
  if (JSON.stringify(stateAfter) !== JSON.stringify(stateBefore)) throw new Error("clicking a dimmed Selection button should leave popup/tab state untouched");
  await spaPopup.close();
  // Now make a real selection and confirm a *fresh* popup instance re-enables the button.
  await pages.spa.evaluate(() => {
    const p = document.querySelector("article p");
    const r = document.createRange();
    r.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  spaPopup = await newTab(`${EXT_ORIGIN}/popup.html?tabId=${spaTabId}`, { width: 380, height: 620 });
  await spaPopup.waitForSelector("button::-p-text(Analyze page)");
  await sleep(400);
  const enabled = await spaPopup.$eval("button::-p-text(Selection)", (b) => b.getAttribute("aria-disabled"));
  note(`after a real selection: aria-disabled=${enabled}`);
  await spaPopup.close();
  if (enabled === "true") throw new Error("Selection button should re-enable once there's a selection");
});

await step("presence modes: onClick / badge / statusChip / inspector / sidePanel", async (note) => {
  // A distinct URL from pages.blog (still open from the very first step, and
  // reused later) -- tabIdOf() matches by URL, and two open tabs sharing the
  // same one made every lookup below resolve to whichever tab chrome.tabs
  // happened to list first, silently pinning the popup to the wrong tab.
  const PRESENCE_URL = `${BASE}/blog.html?e2e=presence`;
  const presenceTab = await newTab(PRESENCE_URL);
  const results = {};
  for (const presence of ["onClick", "badge", "statusChip", "inspector", "sidePanel"]) {
    await mergeSettings({ presence, autoRunPolicy: "always" });
    // Options' own preset select is the product path for switching presets (round-trips through presenceDefaults()).
    await options.bringToFront();
    await options.select('select[aria-label="Presence"]', presence).catch(async () => {
      // Fallback: some builds label it differently; apply the full preset directly.
      await setPresence(presence, { autoRunPolicy: "always" });
    });
    await presenceTab.reload({ waitUntil: "load" });
    await sleep(2200); // autoRun (classifierLite) + surface reconciliation
    const settings = await getStoredSettings();
    const pillVisible = (await piercedCenter(presenceTab, (tag, a) => a.role === "region" && a["aria-label"] === "AI text detector")).length > 0;
    const chipVisible = (await piercedTexts(presenceTab, (tag, a) => a["aria-label"]?.startsWith("AI detection"))).length > 0;
    results[presence] = { surfaces: settings.surfaces, pillVisible, chipVisible };
    note(`${presence}: surfaces=${JSON.stringify(settings.surfaces)}, pill=${pillVisible}, chip=${chipVisible}`);
    // Taken inside the loop, on the "inspector" iteration specifically --
    // a shot() after the loop would show whatever preset ran last (sidePanel).
    if (presence === "inspector") await shot(presenceTab, "page-presence-inspector.jpg");
  }
  report.facts.presenceModes = results;
  if (results.onClick.pillVisible) throw new Error("onClick preset should show no pill automatically");
  if (results.badge.pillVisible || results.badge.chipVisible) throw new Error("badge preset should show neither pill nor chip");
  if (!results.inspector.pillVisible) throw new Error("inspector preset should auto-show the pill");

  // Back to onClick: "Show on page" should turn the pill on for this visit only.
  // Full preset fields (not just `presence`) -- a partial merge would leave
  // autoRunPolicy/surfaces at whatever the loop's last iteration (sidePanel)
  // set them to, same class of bug as the URL collision above.
  await setPresence("onClick");
  await presenceTab.reload({ waitUntil: "load" });
  await sleep(800);
  const onClickTabId = await tabIdOf(PRESENCE_URL);
  // A dedicated popup instance (see the toasts step above for why: re-navigating the shared `popup` has wedged its CDP session before).
  const onClickPopup = await newTab(`${EXT_ORIGIN}/popup.html?tabId=${onClickTabId}`, { width: 380, height: 620 });
  await onClickPopup.waitForSelector("button::-p-text(Show on page)", { timeout: 5000 });
  await clickButtonByText(onClickPopup, "Show on page");
  await sleep(600);
  await onClickPopup.close();
  const shown = (await piercedCenter(presenceTab, (tag, a) => a.role === "region" && a["aria-label"] === "AI text detector")).length > 0;
  note(`onClick + "Show on page": pill visible = ${shown}`);
  if (!shown) throw new Error(`"Show on page" should reveal the pill for this visit`);

  // "toggle-visibility" command path: same handler as the keyboard shortcut, via the tab message directly.
  await swEval((id) => chrome.tabs.sendMessage(id, { kind: "request", id: "e2e-toggle", type: "toggleVisibility", payload: undefined }), onClickTabId);
  await sleep(500);
  const hiddenAfterToggle = (await piercedCenter(presenceTab, (tag, a) => a.role === "region" && a["aria-label"] === "AI text detector")).length === 0;
  note(`toggleVisibility once: pill hidden = ${hiddenAfterToggle}`);
  if (!hiddenAfterToggle) throw new Error("toggleVisibility should hide a pill that 'Show on page' revealed");

  await setPresence("inspector");
  await presenceTab.close();
});

await step("status chip: label, colour graduation, expand/collapse", async (note) => {
  await setPresence("statusChip");
  await pages.news.reload({ waitUntil: "load" });
  // The chip host mounts at content-script boot (before any analysis
  // finishes), but boot itself can lag behind Puppeteer's own "load" event
  // under system load, so poll rather than a single timed check.
  const chip = await waitFor(() => piercedCenter(pages.news, (tag, a) => a["aria-label"]?.startsWith("AI detection")), {
    timeout: 10_000,
    what: "chip host",
  });
  if (!chip.length) throw new Error("chip not found on the default (Status chip) preset");
  const before = await piercedTexts(pages.news, (tag, a) => a["aria-label"]?.startsWith("AI detection"));
  note(`chip label: "${before.join("")}"`);
  await shot(pages.news, "page-chip.jpg");
  await pages.news.mouse.click(chip[0].x, chip[0].y);
  await sleep(500);
  const pillAfterExpand = (await piercedCenter(pages.news, (tag, a) => a.role === "region" && a["aria-label"] === "AI text detector")).length > 0;
  note(`chip click -> pill visible: ${pillAfterExpand}`);
  if (!pillAfterExpand) throw new Error("clicking the chip should expand the full inspector");
  // Expanding kicks off a real analysis (runFullAnalysis()); while it's
  // running the pill's "Analyzing… N%" panel occupies the same bottom-right
  // corner as the chip (both default to it) and, painted after the chip in
  // DOM order, sits on top of it -- a click "on the chip" during that window
  // actually lands on the pill. Wait for the run to finish (same corner,
  // smaller resting panel) before going for the collapse control.
  await waitFor(async () => (await ext(popup, "getTabStatus", { tabId: newsTabId })).state === "done", { timeout: 20_000, what: "chip-triggered analysis to finish" });
  const collapse = await piercedCenter(pages.news, (tag, a) => a["aria-label"] === "Hide the AI detection panel");
  if (!collapse.length) throw new Error("no collapse (\"×\") control on the expanded chip");
  // The pill docks above the expanded chip (pill.dockToChip), so the chip's
  // "×" is reachable by a real mouse click in the shared corner.
  await pages.news.mouse.click(collapse[0].x, collapse[0].y);
  await sleep(500);
  const pillAfterCollapse = (await piercedCenter(pages.news, (tag, a) => a.role === "region" && a["aria-label"] === "AI text detector")).length > 0;
  note(`collapse control -> pill visible: ${pillAfterCollapse}`);
  if (pillAfterCollapse) throw new Error("the collapse control should hide the pill again");
  await setPresence("inspector");
  await pages.news.reload({ waitUntil: "load" });
  await sleep(800);
});

await step("slop filter: dims/collapses AI-scored forum comments, 'Show' reveals one", async (note) => {
  await setPresence("inspector");
  // threshold near 0: this checks the filtering *mechanism* (dim + "Show" +
  // reveal-on-click), not classifierLite's accuracy on this synthetic text --
  // classifierLite trends low on this style of prose (see the blog.html
  // fixture's own comments, ~0.004 overall), so a realistic 0.5+ threshold
  // could legitimately filter nothing here and tell us nothing about the UI.
  await mergeSettings({ slopFilter: { enabled: true, threshold: 0.05, style: "dim", sites: { reddit: true, hackernews: true, youtube: true, twitter: true, forum: true, review: true }, searchMarkers: true } });
  const commentsPage = await newTab(`${BASE}/comments.html`);
  const commentsTabId = await tabIdOf(`${BASE}/comments.html`);
  // Poll for the autoRun analysis to finish rather than a fixed sleep --
  // this used to be a flat 2500ms, timed against this machine's WASM speed.
  // On CI's much slower, GPU-less runner (confirmed via --no-gpu locally:
  // the fixture's scores are plenty high under real WASM/q8 -- fakespot
  // 0.93, tmr 0.64, ensemble ~0.89 on the AI comment, comfortably over the
  // 0.05 threshold -- so this was a timing bug, not a calibration one), that
  // fixed wait was landing before the result did, before any badges exist.
  const commentsStatus = await waitFor(
    async () => {
      const s = await ext(popup, "getTabStatus", { tabId: commentsTabId });
      return s.state === "done" || s.state === "error" ? s : null;
    },
    { timeout: 60_000, what: "slop-filter comments analysis" },
  );
  if (commentsStatus.state === "error") throw new Error(commentsStatus.error);
  await sleep(300); // applyStructuredExtras() paints just after the "done" status fires
  const badges = await commentsPage.$$eval(".ai-detector-slop-badge", (els) => els.map((e) => e.textContent));
  note(`slop badges ("Show" affordance): ${badges.join(" | ")}`);
  if (!badges.length) throw new Error("expected at least one comment dimmed by the slop filter");
  await shot(commentsPage, "page-slop-filter.jpg");
  const dimmedCountBefore = await commentsPage.$$eval('[data-ai-detector-slop]', (els) => els.filter((e) => e.style.opacity === "0.35").length);
  const badgeHandle = (await commentsPage.$$(".ai-detector-slop-badge"))[0];
  await badgeHandle.evaluate((el) => el.click());
  await sleep(200);
  const dimmedCountAfter = await commentsPage.$$eval('[data-ai-detector-slop]', (els) => els.filter((e) => e.style.opacity === "0.35").length);
  note(`dimmed before "Show" click: ${dimmedCountBefore}, after: ${dimmedCountAfter}`);
  if (dimmedCountAfter !== dimmedCountBefore - 1) throw new Error("clicking a slop-filter badge should reveal exactly that one item");
  await mergeSettings({ slopFilter: { enabled: false, threshold: 0.5, style: "dim", sites: { reddit: true, hackernews: true, youtube: true, twitter: true, forum: true, review: true }, searchMarkers: true } });
  await commentsPage.close();
});

await step("context menu 'Check text in this box' (editable, via hook)", async (note) => {
  await pages.spa.bringToFront();
  await pages.spa.evaluate(() => {
    const ta = document.createElement("textarea");
    ta.id = "lad-e2e-editable";
    ta.value =
      "Learning a new skill as an adult can be challenging, but it is absolutely achievable with the right approach. Consistency matters far more than intensity: a little practice every day beats a long cram session once a week, and it keeps the habit from turning into a chore.";
    ta.style.cssText = "position:fixed;top:8px;left:8px;width:300px;height:80px;z-index:999999";
    document.body.appendChild(ta);
    ta.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
  const spaTab = await tabIdOf(pages.spa.url());
  await swEval((id) => globalThis.__ladContextMenuEditable(id), spaTab);
  const s = await waitFor(
    async () => {
      const st = await ext(popup, "getTabStatus", { tabId: spaTab });
      return st.state === "done" || st.state === "error" ? st : null;
    },
    { timeout: 60_000, what: "editable-box analysis" },
  );
  if (s.state === "error") throw new Error(s.error);
  note(`editable box: overall ${s.result.overall.toFixed(3)}, ${s.result.sentences.length} sentences`);
  await pages.spa.evaluate(() => document.getElementById("lad-e2e-editable")?.remove());
});

await step("side panel: follows the active tab, lists flagged sentences, scroll-to-sentence", async (note) => {
  await pages.news.bringToFront();
  await ext(popup, "analyzeTab", { tabId: await tabIdOf(pages.news.url()), target: "page" });
  const sidepanel = await newTab(`${EXT_ORIGIN}/sidepanel.html`, { width: 380, height: 700 });
  // A real side panel isn't a tab, so `browser.tabs.query({active:true})`
  // (sidepanel/main.ts's `followActiveTab`) normally still resolves to the
  // page it's docked next to. Here it's opened as an ordinary tab (Chrome
  // testing has no API to dock a real side panel), which makes IT the
  // active tab -- so re-activate the news tab, which the panel's own
  // `tabs.onActivated` listener picks up.
  await pages.news.bringToFront();
  await sidepanel.waitForSelector(".sp-summary, .sp-empty", { timeout: 10_000 });
  await sleep(500);
  const score = await sidepanel.$eval(".sp-score", (e) => e.textContent).catch(() => null);
  const items = await sidepanel.$$eval(".sp-item", (els) => els.length);
  note(`side panel: score "${score}", ${items} flagged items listed`);
  await shot(sidepanel, "sidepanel.jpg");
  if (items > 0) {
    await pages.news.evaluate(() => window.scrollTo(0, 0));
    await clickSelector(sidepanel, ".sp-item");
    await sleep(500);
    const y = await pages.news.evaluate(() => window.scrollY);
    note(`scrollY after clicking a flagged item: ${y}`);
    if (y === 0) throw new Error("clicking a side-panel item should scroll the page to that sentence");
  }
  await sidepanel.close();
});

await setPresence("inspector", { autoRunPolicy: "never" }); // leave storage in a known state before the final network check

// ---- network: only huggingface.co / *.hf.co / the voice models' GitHub release assets (+ the local fixture server) ----
await step("network: only Hugging Face + GitHub release-asset hosts (and the local fixture server)", async (note) => {
  await browser.close();
  await sleep(500);
  const hosts = hostsFromNetLog(readFileSync(NETLOG, "utf8"));
  report.network = hosts;
  const allowed = (h) =>
    /(^|\.)huggingface\.co$/.test(h.replace(/:\d+$/, "")) ||
    /(^|\.)hf\.co$/.test(h.replace(/:\d+$/, "")) ||
    // The voice-check models (on by default) ship as GitHub release assets,
    // not on Hugging Face (src/engine/voiceModels.ts, src/engine/voiceHost.ts)
    // -- host_permissions in wxt.config.ts declares both explicitly. Only
    // hit on a profile that doesn't have them cached yet (a fresh install).
    /(^|\.)github\.com$/.test(h.replace(/:\d+$/, "")) ||
    /(^|\.)githubusercontent\.com$/.test(h.replace(/:\d+$/, "")) ||
    /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h);
  // Chrome itself (not the extension) talks to Google services in a fresh profile.
  const browserOwn = (h) => /(google|gstatic|googleapis|gvt1|chromium|clients\d?\.google)\./.test(h);
  const bad = Object.keys(hosts).filter((h) => !allowed(h) && !browserOwn(h));
  note(`hosts: ${Object.entries(hosts).map(([h, n]) => `${h}×${n}`).join(", ")}`);
  if (Object.keys(hosts).some((h) => h.includes("jsdelivr"))) throw new Error("request to jsdelivr!");
  if (bad.length) throw new Error(`unexpected hosts: ${bad.join(", ")}`);
});

srv.close();
report.facts.consoleErrorCount = consoleLog.filter((c) => c.type === "error" || c.type === "pageerror").length;
save(OUT);
const failed = report.steps.filter((s) => !s.ok);
console.log(`\n${report.steps.length - failed.length}/${report.steps.length} steps passed. Report: ${OUT}`);
console.log(`console errors/warnings captured: ${consoleLog.length}`);
for (const c of consoleLog.slice(0, 40)) console.log(`  [${c.type}] ${c.ctx}: ${c.text}`);
process.exit(failed.length ? 1 : 0);
