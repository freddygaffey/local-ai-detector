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
import { hostsFromNetLog, makeReport, piercedCenter, piercedTexts, sleep, waitFor } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const EXT = resolve(opt("--ext", ".output/chrome-mv3-e2e"));
const SCRATCH = process.env.LAD_SCRATCH ?? resolve("node_modules/.cache/lad-e2e");
const PROFILE = resolve(opt("--profile", join(SCRATCH, "chrome-profile")));
const OUT = resolve(opt("--out", join(SCRATCH, "chrome-report.json")));
const SHOTS = opt("--shots") ? resolve(opt("--shots")) : null;
const HEADED = args.includes("--headed");
const QUICK = args.includes("--quick");
const FRESH = args.includes("--fresh");
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
const srv = await startServer(0);
const BASE = `http://localhost:${srv.port}`;

const browser = await puppeteer.launch({
  executablePath: chromium.executablePath(),
  headless: !HEADED,
  pipe: true,
  enableExtensions: [EXT],
  userDataDir: PROFILE,
  defaultViewport: null,
  args: [
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1100,800",
    `--log-net-log=${NETLOG}`,
    "--net-log-capture-mode=Default",
  ],
});
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
const sw = await swTarget.worker();
report.facts.extensionOrigin = EXT_ORIGIN;

async function newTab(url, viewport = { width: 1000, height: 720 }) {
  const p = await browser.newPage();
  await p.setViewport(viewport);
  await p.goto(url, { waitUntil: "load" });
  return p;
}
async function tabIdOf(url) {
  return sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
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
  await page.screenshot({ path: join(SHOTS, name), type: name.endsWith(".png") ? "png" : "jpeg", quality: name.endsWith(".png") ? undefined : 70, ...opts });
}
const highlightCount = (page) =>
  page.evaluate(() => [...CSS.highlights.keys()].filter((k) => k.startsWith("ai-detector-hl")).reduce((n, k) => n + CSS.highlights.get(k).size, 0));
const highlightNames = (page) => page.evaluate(() => [...CSS.highlights.keys()].filter((k) => k.startsWith("ai-detector-hl") && CSS.highlights.get(k).size));

// ---------------------------------------------------------------------------
const pages = {};
await step("open fixture pages (news, blog, spa, demo)", async (note) => {
  for (const name of ["news", "blog", "spa", "demo"]) {
    pages[name] = await newTab(`${BASE}/${name}.html`);
  }
  await sleep(800);
  // The content script's pill host is present on every page.
  const pill = await piercedCenter(pages.news, (tag, a) => tag === "button" && a["aria-label"] === "Scan this page for AI-written text");
  if (!pill.length) throw new Error("pill 'Scan page' button not found");
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
  await popup.click("button::-p-text(Download & enable)");
  await popup.waitForSelector("button::-p-text(Analyze page)", { timeout: 5000 });
});

async function setMode(mode) {
  await popup.select('select[aria-label="Detector mode"]', mode);
  await waitFor(async () => (await popup.evaluate(async () => (await chrome.storage.sync.get("settings")).settings?.mode)) === mode, {
    what: `mode ${mode}`,
  });
}

async function analyzeViaPopup(mode, label) {
  await setMode(mode);
  await popup.evaluate(() => (window.__ev = []));
  const t0 = Date.now();
  await popup.click("button::-p-text(Analyze page)");
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

// Finish on ensemble so the screenshots show the default mode.
await setMode("ensemble");
await ext(popup, "analyzeTab", { tabId: newsTabId, target: "page" });

await step("highlight styles switch live (heatmap -> flagged -> underline -> heatmap)", async (note) => {
  await pages.news.bringToFront();
  await pages.news.evaluate(() => window.scrollTo(0, 0));
  for (const style of ["heatmap", "flagged", "underline", "heatmap"]) {
    await popup.select('select[aria-label="Highlight style"]', style);
    const names = await waitFor(
      async () => {
        const n = await highlightNames(pages.news);
        return n.length && n.every((k) => k.includes(`-${style}-`)) ? n : null;
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
  if (s.withCredentials < 1) problems.push("no C2PA image");
  if (s.withWatermark < 1) problems.push("no SD watermark");
  if (s.withUnsignedClaim < 1) problems.push("no unsigned metadata claim");
  if (!s.permissionNeeded.some((p) => p.includes("127.0.0.1"))) problems.push("cross-origin image didn't ask for permission");
  const c2paErr = consoleLog.filter((c) => /c2pa|worker/i.test(c.text));
  if (c2paErr.length) note(`c2pa-related console: ${c2paErr.map((c) => c.text).join(" / ").slice(0, 300)}`);
  await pages.news.evaluate(() => document.querySelector('img[src="/img/c2pa.jpg"]').scrollIntoView({ block: "center" }));
  await sleep(400);
  await shot(pages.news, "page-image-badges.jpg");
  await popup.reload();
  await sleep(1200);
  await shot(popup, "popup-images.png", { fullPage: true });
  if (problems.length) throw new Error(problems.join("; "));
});

await step("C2PA details (c2pa-web worker ran in the offscreen document)", async (note) => {
  const res = await sw.evaluate(async (src) => {
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
  await sw.evaluate((id) => globalThis.__ladContextMenuSelection(id), spaTab);
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
  await sw.evaluate((id) => globalThis.__ladContextMenuSelection(id), spaTab);
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

await step("classifier vs lite on fixture pages (overall scores)", async (note) => {
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

await step("WebGPU vs WASM (settings.useWebGPU) on the same pages", async (note) => {
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
  await setGpu(true);
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
  await options.click("button::-p-text(Check for updates)");
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
  await btns[0].click();
  await waitFor(async () => !(await options.$("::-p-text(Checking…)")), { what: "validation UI" });
  await sleep(300);
  const el = await options.$(".license-warning, .model-error-note");
  if (el) await el.scrollIntoView();
  await shot(options, "options-custom-model.jpg");
});

// ---- network: only huggingface.co / *.hf.co (+ the local fixture server) ----
await step("network: only Hugging Face hosts (and the local fixture server)", async (note) => {
  await browser.close();
  await sleep(500);
  const hosts = hostsFromNetLog(readFileSync(NETLOG, "utf8"));
  report.network = hosts;
  const allowed = (h) =>
    /(^|\.)huggingface\.co$/.test(h.replace(/:\d+$/, "")) ||
    /(^|\.)hf\.co$/.test(h.replace(/:\d+$/, "")) ||
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
