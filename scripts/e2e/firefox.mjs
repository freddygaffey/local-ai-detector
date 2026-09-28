#!/usr/bin/env node
// Automated Firefox E2E (docs/qa.md). Installs the e2e build as a temporary
// add-on in a fresh, throwaway Firefox profile via Selenium/geckodriver
// (selenium-manager fetches geckodriver), with REAL model downloads.
//
//   npm run build:e2e:firefox && node scripts/e2e/firefox.mjs [--firefox /path/to/firefox]
//        [--out report.json] [--shots dir] [--full] [--idle-timeout 20000]
//
// The suite talks to the extension through the e2e-only page <->
// content-script bridge (src/e2e/bridge.ts): the same content -> background
// path the in-page pill uses. Selenium's Firefox driver refuses to run
// scripts in moz-extension:// pages ("privileged browsing contexts"), so the
// popup and options pages are only screenshotted. `--idle-timeout` lowers the event
// page's idle timeout (Firefox default 30 s) so downloads outlast it and the
// keep-alive is really exercised.
// --full adds Binoculars (another ~270 MB download).

import { mkdirSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { startServer } from "./server.mjs";
import { makeReport, sleep, waitFor } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const EXT = resolve(opt("--ext", ".output/firefox-mv3-e2e"));
const SCRATCH = process.env.LAD_SCRATCH ?? resolve("node_modules/.cache/lad-e2e");
const OUT = resolve(opt("--out", join(SCRATCH, "firefox-report.json")));
const SHOTS = opt("--shots") ? resolve(opt("--shots")) : null;
const FULL = args.includes("--full");
const IDLE = Number(opt("--idle-timeout", "20000"));
const FIREFOX = opt("--firefox", "/Applications/Firefox.app/Contents/MacOS/firefox");
const UUID = "5b6c1d2e-0000-4000-8000-00000000a1d0";
const ADDON_ID = "local-ai-detector@freddygaffey.github.io";
const LOG = join(SCRATCH, `firefox-stdout-${Date.now()}.log`);
mkdirSync(SCRATCH, { recursive: true });
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const { report, step, save } = makeReport("firefox");
const srv = await startServer(0);
const BASE = `http://localhost:${srv.port}`;
const EXT_BASE = `moz-extension://${UUID}`;

const options = new firefox.Options()
  .setBinary(FIREFOX)
  .addArguments("-headless")
  .setPreference("extensions.webextensions.uuids", JSON.stringify({ [ADDON_ID]: UUID }))
  // Extension console output -> Firefox stdout (captured in LOG).
  .setPreference("devtools.console.stdout.chrome", true)
  .setPreference("devtools.console.stdout.content", true)
  // Make the event page idle out quickly, so keep-alive during long
  // downloads is really tested.
  .setPreference("extensions.background.idle.timeout", IDLE)
  .windowSize({ width: 1100, height: 800 });
const service = new firefox.ServiceBuilder().setStdio(["ignore", openSync(LOG, "w"), openSync(LOG, "a")]);
const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).setFirefoxService(service).build();
report.facts.browserVersion = (await driver.getCapabilities()).get("browserVersion");
report.facts.eventPageIdleTimeoutMs = IDLE;

await driver.installAddon(EXT, true);
await sleep(1000);

// Everything goes through the e2e-only page <-> content-script bridge
// (src/e2e/bridge.ts), i.e. the same content -> background path the in-page
// pill uses.
const tabs = {};
async function openTab(name, url) {
  await driver.switchTo().newWindow("tab");
  await driver.get(url);
  tabs[name] = { handle: await driver.getWindowHandle() };
  await sleep(700);
  tabs[name].id = await bridge(name, "bg", { type: "tabId" });
  return tabs[name];
}
async function bridge(name, op, fields = {}, timeoutMs = 20 * 60_000) {
  await driver.switchTo().window(tabs[name].handle);
  await driver.manage().setTimeouts({ script: timeoutMs });
  const res = await driver.executeAsyncScript(
    `const [op, fields, done] = arguments;
     const id = "e2e-" + Math.random();
     const on = (e) => { if (e.source === window && e.data && e.data.__ladE2E === "res" && e.data.id === id) { removeEventListener("message", on); done(e.data); } };
     addEventListener("message", on);
     window.postMessage(Object.assign({ __ladE2E: "req", id, op }, fields), "*");`,
    op,
    fields,
  );
  if (!res.ok) throw new Error(res.error);
  return res.result;
}
const send = (name, type, payload) => bridge(name, "send", { type, payload });
const setSettings = (partial) => bridge("news", "settings", { partial });
async function shot(handle, file) {
  if (!SHOTS) return;
  await driver.switchTo().window(handle);
  writeFileSync(join(SHOTS, file), Buffer.from(await driver.takeScreenshot(), "base64"));
}
async function inTab(name, fn, ...a) {
  await driver.switchTo().window(tabs[name].handle);
  return driver.executeScript(`return (${fn.toString()})(...arguments)`, ...a);
}
const hlCount = (name) =>
  inTab(name, () =>
    [...CSS.highlights.keys()].filter((k) => k.startsWith("ai-detector-hl")).reduce((n, k) => n + CSS.highlights.get(k).size, 0),
  );

// ---------------------------------------------------------------------------
await step("install temporary add-on; open fixture tabs; bridge reaches the background", async (note) => {
  for (const name of ["news", "blog", "spa"]) await openTab(name, `${BASE}/${name}.html`);
  note(`tab ids ${Object.entries(tabs).map(([k, v]) => `${k}=${v.id}`).join(", ")}`);
  const info = await send("news", "getEngineInfo", undefined);
  note(`engine before first use: ${JSON.stringify(info.runtime)}`);
  const pill = await inTab("news", () => !!document.querySelector("ai-detector-pill, [data-ai-detector-pill]") || document.documentElement.innerHTML.includes("ai-detector"));
  note(`content script present: ${pill}`);
});

await step("consent", async () => {
  await setSettings({ consentedDownload: true });
});

// Same as scripts/e2e/chrome.mjs: the highlight assertions below predate
// Presence modes, and the default corner card paints nothing until its highlights toggle.
await step("presence: force Inspector (highlights on), auto-run off, for the fixture runs", async (note) => {
  await setSettings({
    presence: "inspector",
    autoRunPolicy: "never",
    surfaces: { popup: true, badge: true, chip: false, highlights: true, sidePanel: false },
  });
  note("presence -> inspector (surfaces.highlights: true), autoRun off");
});

async function analyze(name, mode, label, target = "page") {
  await setSettings({ mode });
  const t0 = Date.now();
  const r = await send(name, "analyzeTab", { target });
  const ms = Date.now() - t0;
  report.timings[label] = { totalMs: ms };
  return { overall: +r.overall.toFixed(3), sentences: r.sentences.length, distinct: new Set(r.sentences.map((s) => s.score.toFixed(4))).size, ms };
}

const MODES = ["classifierLite", "ensemble", "classifier", "perplexity", ...(FULL ? ["binoculars"] : [])];
for (const mode of MODES) {
  await step(`analyze news — ${mode} (cold: download + load)`, async (note) => {
    const r = await analyze("news", mode, `${mode}-cold`);
    note(`overall ${r.overall}, ${r.sentences} sentences (${r.distinct} distinct scores), ${r.ms} ms`);
    const n = await waitFor(() => hlCount("news"), { timeout: 5000, what: "highlights" });
    note(`${n} highlight ranges`);
    if (r.distinct < 2) throw new Error("degenerate scores");
  });
}
for (const mode of MODES) {
  await step(`analyze blog — ${mode} (warm)`, async (note) => {
    const r = await analyze("blog", mode, `${mode}-warm`);
    note(`overall ${r.overall}, ${r.ms} ms`);
  });
}

await step("engine info (module worker, threads, isolation, cache)", async (note) => {
  const info = await send("news", "getEngineInfo", undefined);
  report.facts.engineInfo = info.runtime;
  note(JSON.stringify(info.runtime));
  if (!info.runtime) throw new Error("inference worker never reported its runtime");
});

await step("event page survived the long downloads (keep-alive)", async (note) => {
  // Per-tab status lives in the event page's memory: if it had been unloaded
  // mid-download the status would be "idle" again.
  const s = await send("news", "getTabStatus", { tabId: tabs.news.id });
  note(`news tab status after all runs: ${s.state}; event-page idle timeout ${IDLE} ms`);
  if (s.state !== "done") throw new Error(`status ${s.state}: the event page was restarted`);
});

await step("highlight styles switch live; Unicode markers", async (note) => {
  await setSettings({ mode: "ensemble" });
  await send("news", "analyzeTab", { target: "page" });
  for (const style of ["flagged", "underline", "heatmap"]) {
    await setSettings({ highlightStyle: style });
    const names = await waitFor(
      () =>
        inTab("news", (style) => {
          const n = [...CSS.highlights.keys()].filter((k) => k.startsWith("ai-detector-hl") && CSS.highlights.get(k).size);
          return (n.length || style === "flagged") && n.every((k) => k.includes(`-${style}-`)) ? n : null;
        }, style),
      { timeout: 5000, what: style },
    );
    note(`${style}: ${names.length} groups`);
  }
  const markers = await inTab("news", () => [...document.querySelectorAll(".ai-detector-unicode-marker")].map((m) => m.textContent));
  note(`markers ${markers.join(" ")}`);
  await shot(tabs.news.handle, "firefox-page-heatmap.png");
});

await step("image provenance in Firefox (C2PA worker from the event page, watermark, metadata)", async (note) => {
  const st = await waitFor(
    async () => {
      const s = await send("news", "getTabStatus", { tabId: tabs.news.id });
      return s.state === "done" && s.result.images && s.result.images.total >= 4 ? s : null;
    },
    { timeout: 60_000, what: "image summary" },
  );
  report.facts.imageSummary = st.result.images;
  note(JSON.stringify(st.result.images));
  const s = st.result.images;
  if (s.withCredentials < 1) throw new Error("C2PA image not recognised (c2pa-web worker in Firefox?)");
  if (s.withWatermark < 1) throw new Error("SD watermark not found");
});

await step("selection + context-menu handler", async (note) => {
  await waitFor(() => inTab("spa", () => !!document.querySelector("article p")), { what: "spa content" });
  await inTab("spa", () => {
    const t = document.querySelectorAll("article p")[0].firstChild;
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(t, Math.min(400, t.data.length));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  const r = await analyze("spa", "ensemble", "selection", "selection");
  note(`analyzeTab(selection): ${r.sentences} sentences, overall ${r.overall}`);
  await bridge("spa", "bg", { type: "contextMenuSelection" });
  const s = await send("spa", "getTabStatus", { tabId: tabs.spa.id });
  note(`context-menu handler: ${s.state}, ${s.result?.sentences.length} sentences`);
  if (s.state !== "done") throw new Error(s.error ?? s.state);
});

await step("popup and options pages render (screenshots only: not scriptable through Selenium)", async (note) => {
  for (const [path, file] of [
    [`/popup.html?tabId=${tabs.news.id}`, "firefox-popup.png"],
    ["/options.html", "firefox-options.png"],
  ]) {
    await bridge("news", "bg", { type: "openPage", payload: { path } });
    await sleep(2000);
    let h = null;
    for (const x of await driver.getAllWindowHandles()) {
      await driver.switchTo().window(x);
      if ((await driver.getCurrentUrl()).includes(path.split("?")[0])) h = x;
    }
    if (!h) throw new Error(`${path} did not open`);
    if (path.startsWith("/popup")) await driver.manage().window().setRect({ width: 420, height: 800 });
    await shot(h, file).catch((e) => note(`screenshot of ${path} failed: ${e.message}`));
    await driver.manage().window().setRect({ width: 1100, height: 800 });
    note(`${path} opened`);
  }
});

await step("console: extension errors in Firefox stdout", async (note) => {
  await driver.quit();
  srv.close();
  await sleep(500);
  const lines = readFileSync(LOG, "utf8").split("\n");
  const ours = lines.filter(
    (l) => /moz-extension:\/\/|Local AI Detector|\[engine\]|\[provenance\]|inference-worker|c2pa|onnx|transformers/i.test(l) && /error|warn|exception|fail/i.test(l),
  );
  report.console = ours.slice(0, 80);
  note(`${ours.length} extension error/warning lines`);
  for (const l of ours.slice(0, 12)) note(l.slice(0, 220));
});

save(OUT);
const failed = report.steps.filter((s) => !s.ok);
console.log(`\n${report.steps.length - failed.length}/${report.steps.length} steps passed. Report: ${OUT}`);
process.exit(failed.length ? 1 : 0);
