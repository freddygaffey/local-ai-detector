#!/usr/bin/env node
// Fusion-mode E2E assertions (T7), in Chrome with the real extension and real
// models: detector sets, the four combination methods, per-sentence and
// overall agreement, the device/dtype record, the calibrated display
// probability, the auto-run fast mode through `analyzeTab`, and the v1 -> v2
// settings migration.
//
//   npm run build:e2e && node scripts/e2e/fusion.mjs [--ext .output/chrome-mv3-e2e] [--profile dir] [--out report.json]

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { chromium } from "playwright";
import { startServer } from "./server.mjs";
import { makeReport, sleep } from "./lib.mjs";

await import("../lib/ts-hooks.mjs");
const { MIN_WORDS_FOR_SCORE, FLAGGED_THRESHOLD } = await import("../../src/shared/thresholds.ts");

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const EXT = resolve(opt("--ext", ".output/chrome-mv3-e2e"));
const SCRATCH = process.env.LAD_SCRATCH ?? resolve("node_modules/.cache/lad-e2e");
const PROFILE = resolve(opt("--profile", join(SCRATCH, "chrome-profile")));
const OUT = resolve(opt("--out", join(SCRATCH, "fusion-report.json")));
if (!existsSync(join(EXT, "manifest.json"))) throw new Error(`No build at ${EXT}. Run npm run build:e2e first.`);
mkdirSync(PROFILE, { recursive: true });
for (const d of ["ScriptCache", "Database"]) rmSync(join(PROFILE, "Default", "Service Worker", d), { recursive: true, force: true });

const { report, step, save } = makeReport("fusion");
const srv = await startServer(0);
const BASE = `http://localhost:${srv.port}`;
const browser = await puppeteer.launch({
  executablePath: chromium.executablePath(),
  headless: true,
  pipe: true,
  enableExtensions: [EXT],
  userDataDir: PROFILE,
  args: ["--no-first-run", "--no-default-browser-check"],
  protocolTimeout: 600_000,
});
const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"));
const origin = swTarget.url().match(/^chrome-extension:\/\/[^/]+/)[0];
const sw = await swTarget.worker();
const extPage = await browser.newPage();
await extPage.goto(`${origin}/options.html`);

async function ext(type, payload) {
  const res = await extPage.evaluate(
    (type, payload) => chrome.runtime.sendMessage({ kind: "request", id: `f-${Math.random()}`, type, payload }),
    type,
    payload,
  );
  if (!res?.ok) throw new Error(`${type}: ${res?.error ?? "no response"}`);
  return res.payload;
}
async function setSettings(patch, { replace = false } = {}) {
  await extPage.evaluate(
    async (patch, replace) => {
      const s = replace ? {} : ((await chrome.storage.sync.get("settings")).settings ?? {});
      await chrome.storage.sync.set({ settings: { ...s, consentedDownload: true, ...patch } });
      await chrome.storage.local.remove("settings");
    },
    patch,
    replace,
  );
}

// Labelled fixture paragraphs -> analyze blocks.
const news = await browser.newPage();
await news.goto(`${BASE}/news.html`, { waitUntil: "load" });
const seg = new Intl.Segmenter("en", { granularity: "sentence" });
const labelled = await news.evaluate(() =>
  [...document.querySelectorAll("[data-src]")].map((e) => ({ src: e.getAttribute("data-src"), text: e.textContent.trim() })),
);
const blocks = labelled.map((p, i) => {
  const sentences = [];
  for (const s of seg.segment(p.text)) {
    const t = s.segment.replace(/\s+$/, "");
    if (t.trim()) sentences.push({ start: s.index, end: s.index + t.length });
  }
  return { id: `b${i}`, text: p.text, sentences };
});
const srcOf = Object.fromEntries(blocks.map((b, i) => [b.id, labelled[i].src]));

// The default Fusion set (fakespot + tmr) plus perplexity, so vote/median is meaningful.
const FULL = ["fakespot", "tmr", "perplexity"];
const analyze = () => ext("analyze", { tabId: -1, mode: "ensemble", blocks });
const results = {};

await step("fusion (3 detectors, weighted): detectors, device, agreement, probability", async (note) => {
  await setSettings({ settingsVersion: 2, mode: "ensemble", useWebGPU: true, fusion: { detectors: FULL, method: "weighted" } });
  const r = (results.weighted = await analyze());
  if (r.detectors?.length !== 3) throw new Error(`expected 3 detectors, got ${JSON.stringify(r.detectors)}`);
  if (JSON.stringify(r.detectors.map((d) => d.id).sort()) !== JSON.stringify([...FULL].sort())) throw new Error("wrong detector ids");
  for (const d of r.detectors) {
    if (!["webgpu", "wasm"].includes(d.device) || !d.dtype) throw new Error(`bad device/dtype ${JSON.stringify(d)}`);
    if (!(d.weight > 0)) throw new Error(`bad weight ${d.weight}`);
  }
  if (!["webgpu", "wasm", "mixed"].includes(r.device)) throw new Error(`bad result.device ${r.device}`);
  const devs = new Set(r.detectors.map((d) => d.device));
  if ((devs.size > 1) !== (r.device === "mixed")) throw new Error("result.device doesn't summarise detector devices");
  const a = r.fusion?.agreement;
  if (!a || a.total !== 3 || a.agree < 0 || a.agree > 3) throw new Error(`bad overall agreement ${JSON.stringify(r.fusion)}`);
  const verdict = r.overall >= FLAGGED_THRESHOLD;
  const expAgree = r.detectors.filter((d) => d.overall >= FLAGGED_THRESHOLD === verdict).length;
  if (a.agree !== expAgree) throw new Error(`overall agreement ${a.agree} != ${expAgree}`);
  for (const s of r.sentences) {
    const ps = Object.values(s.detectors ?? {});
    if (!s.agreement || s.agreement.total !== ps.length) throw new Error(`sentence without agreement ${JSON.stringify(s)}`);
    const v = s.score >= FLAGGED_THRESHOLD;
    if (s.agreement.agree !== ps.filter((p) => p >= FLAGGED_THRESHOLD === v).length) throw new Error("sentence agreement miscounted");
  }
  if (r.words >= MIN_WORDS_FOR_SCORE && !(r.probability > 0 && r.probability < 1)) throw new Error(`probability ${r.probability}`);
  note(`overall ${r.overall.toFixed(3)} (P ${r.probability?.toFixed(2)}), ${a.agree}/${a.total} agree, disagree=${a.disagree}; devices ${r.detectors.map((d) => `${d.id}:${d.device}/${d.dtype}`).join(", ")}`);
});

await step("fusion methods: vote = median, max = highest, logodds between", async (note) => {
  for (const method of ["vote", "max", "logodds"]) {
    await setSettings({ fusion: { detectors: FULL, method } });
    results[method] = await analyze();
  }
  const per = results.weighted.detectors.map((d) => d.overall).sort((a, b) => a - b);
  const close = (a, b) => Math.abs(a - b) < 1e-3;
  if (!close(results.vote.overall, per[1])) throw new Error(`vote ${results.vote.overall} != median ${per[1]}`);
  if (!close(results.max.overall, per[2])) throw new Error(`max ${results.max.overall} != ${per[2]}`);
  if (results.logodds.overall < per[0] - 1e-6 || results.logodds.overall > per[2] + 1e-6) throw new Error("logodds outside detector range");
  for (const m of ["vote", "max", "logodds"]) if (results[m].fusion?.method !== m) throw new Error(`method not recorded for ${m}`);
  const flagged = (r) => r.sentences.filter((s) => s.score >= FLAGGED_THRESHOLD).length;
  if (flagged(results.max) < flagged(results.vote)) throw new Error("max flags fewer sentences than vote");
  note(Object.entries(results).map(([k, r]) => `${k} ${r.overall.toFixed(3)} (${flagged(r)} flagged)`).join(", "));
});

await step("per-paragraph flag rates on labelled news fixture (default fusion)", async (note) => {
  const r = results.weighted;
  const rate = (src) => {
    const ss = r.sentences.filter((s) => srcOf[s.blockId] === src);
    return { n: ss.length, flagged: ss.filter((s) => s.score >= FLAGGED_THRESHOLD).length };
  };
  const h = rate("human");
  const a = rate("ai");
  note(`human ${h.flagged}/${h.n}, ai ${a.flagged}/${a.n}`);
  if (h.flagged / h.n > 0.2) throw new Error("more than 20% of human sentences flagged");
  if (a.flagged / a.n <= h.flagged / h.n) throw new Error("AI paragraphs not flagged more than human ones");
});

await step("analyzeTab honours an explicit mode (auto-run fast pass)", async (note) => {
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, `${BASE}/news.html`);
  const r = await ext("analyzeTab", { tabId, target: "page", mode: "classifierLite" });
  if (r.detectors?.length !== 1 || r.detectors[0].id !== "lite") throw new Error(`expected lite only, got ${JSON.stringify(r.detectors)}`);
  if (r.fusion) throw new Error("single-detector run should have no fusion block");
  const st = await ext("getTabStatus", { tabId });
  if (st.state !== "done" || st.mode !== "classifierLite") throw new Error(`tab status ${st.state}/${st.mode}`);
  note(`lite ${r.overall.toFixed(3)} on ${r.detectors[0].device}/${r.detectors[0].dtype}, P ${r.probability?.toFixed(2)}`);
});

await step("v1 settings migrate: lite ensemble kept, WebGPU turned on", async (note) => {
  await setSettings({ mode: "ensemble", ensembleClassifier: "classifierLite", useWebGPU: false }, { replace: true });
  await sleep(200);
  const r = await analyze();
  const ids = r.detectors.map((d) => d.id).join("+");
  if (ids !== "lite+perplexity") throw new Error(`expected lite+perplexity, got ${ids}`);
  const info = await ext("getEngineInfo", undefined);
  const gpu = info.runtime?.shaderF16;
  if (gpu && !r.detectors.some((d) => d.device === "webgpu")) throw new Error("WebGPU available but nothing ran on it after migration");
  note(`${ids} on ${r.device}; adapter shader-f16: ${gpu}`);
});

await setSettings({ settingsVersion: 2, fusion: { detectors: FULL, method: "weighted" }, useWebGPU: true, mode: "ensemble" });
save(OUT);
await browser.close();
srv.close?.();
const failed = report.steps.filter((s) => !s.ok);
console.log(`\n${report.steps.length - failed.length}/${report.steps.length} passed -> ${OUT}`);
process.exit(failed.length ? 1 : 0);
