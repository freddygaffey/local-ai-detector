#!/usr/bin/env node
// T7 browser calibration run: every text of the web eval set
// (scripts/eval/build-eval-set.mjs) through the REAL extension in Chrome,
// one detector at a time, on WebGPU (primary) and WASM (fallback), with the
// dtype under test. Records each text's document score and its per-paragraph
// scores, plus the device/dtype that actually ran, so
// scripts/eval/fit-t7.mjs can recover raw statistics (by inverting the
// constants recorded here) and fit the shipping constants.
//
//   node scripts/e2e/browser-t7-calibration.mjs --ext <chrome-mv3-e2e dir> --eval eval-set.json \
//     --out runs.json [--profile dir] [--runs webgpu:tmr,wasm:tmr,webgpu:tmr@fp16,...] [--split fit|test|all]
//
// A run is device:detector[@webgpuDtype]. Results are appended to --out and
// already-done (run, text) pairs are skipped, so it can be resumed.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { chromium } from "playwright";

await import("../lib/ts-hooks.mjs");
const { WASM_CALIBRATION, WEBGPU_CALIBRATION } = await import("../../src/engine/calibration.ts");

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const EXT = resolve(opt("--ext", ".output/chrome-mv3-e2e"));
const PROFILE = resolve(opt("--profile", join(process.env.LAD_SCRATCH ?? "node_modules/.cache/lad-e2e", "t7-profile")));
const OUT = resolve(opt("--out", "t7-runs.json"));
const SPLIT = opt("--split", "all");
const LIMIT = Number(opt("--limit", "0"));
const RUNS = opt("--runs", "webgpu:tmr,webgpu:lite,webgpu:modernbert,webgpu:perplexity,wasm:tmr,wasm:lite,wasm:modernbert,wasm:perplexity")
  .split(",")
  .map((r) => {
    const [device, rest] = r.split(":");
    const [detector, dtype] = rest.split("@");
    return { key: r, device, detector, dtype };
  });
const SLOT = { fakespot: "classifierFakespot", tmr: "classifier", lite: "classifierLite", modernbert: "classifierModernBert", perplexity: "perplexityLM", binoculars: ["binocularsObserver", "binocularsPerformer"] };

let items = JSON.parse(readFileSync(opt("--eval"), "utf8"));
if (SPLIT !== "all") items = items.filter((r) => r.split === SPLIT);
if (!args.includes("--with-mage")) items = items.filter((r) => r.set !== "mage");
if (LIMIT) items = items.slice(0, LIMIT);
// --sample N: a smaller, deterministic subset (ids sorted, i.e. a hash order), e.g. for the WASM fallback.
const SAMPLE = Number(opt("--sample", "0"));
if (SAMPLE) items = [...items].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, SAMPLE);
// --shard k/n (CI matrix): every n-th text of the id-sorted list, starting at k.
const SHARD = opt("--shard");
if (SHARD) {
  const [k, n] = SHARD.split("/").map(Number);
  items = [...items].sort((a, b) => (a.id < b.id ? -1 : 1)).filter((_, i) => i % n === k);
}

// ---- text -> page-like paragraphs (as scripts/e2e/browser-unit-calibration.mjs) ----
const seg = new Intl.Segmenter("en", { granularity: "sentence" });
const sentencesOf = (para) => {
  const out = [];
  for (const s of seg.segment(para)) {
    const t = s.segment.replace(/\s+$/, "");
    if (t.trim()) out.push({ start: s.index, end: s.index + t.length });
  }
  return out;
};
const words = (t) => t.split(/\s+/).filter(Boolean).length;
function toParagraphs(text) {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of paras) {
    if (words(p) < 120) {
      out.push(p);
      continue;
    }
    let cur = "";
    for (const s of sentencesOf(p)) {
      cur += (cur ? " " : "") + p.slice(s.start, s.end);
      if (words(cur) >= 60) {
        out.push(cur);
        cur = "";
      }
    }
    if (cur) out.length && words(cur) < 30 ? (out[out.length - 1] += " " + cur) : out.push(cur);
  }
  return out;
}
const toBlocks = (text) => toParagraphs(text).map((t, i) => ({ id: `p${i}`, text: t, sentences: sentencesOf(t) }));

const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { runs: {} };
results.constants = { wasm: WASM_CALIBRATION, webgpu: WEBGPU_CALIBRATION };
const save = () => writeFileSync(OUT, JSON.stringify(results));

for (const d of ["ScriptCache", "Database"]) rmSync(join(PROFILE, "Default", "Service Worker", d), { recursive: true, force: true });
const browser = await puppeteer.launch({
  executablePath: chromium.executablePath(),
  headless: true,
  pipe: true,
  enableExtensions: [EXT],
  userDataDir: PROFILE,
  // CI (Ubuntu 24.04 runners) blocks Chrome's user-namespace sandbox.
  args: ["--no-first-run", "--enable-unsafe-webgpu", ...(process.env.CI ? ["--no-sandbox"] : [])],
  protocolTimeout: 900_000,
});
const swT = await browser.waitForTarget((t) => t.type() === "service_worker");
const origin = swT.url().match(/^chrome-extension:\/\/[^/]+/)[0];
const page = await browser.newPage();
await page.goto(`${origin}/options.html`);
const send = async (type, payload) => {
  const r = await page.evaluate(
    (type, payload) => chrome.runtime.sendMessage({ kind: "request", id: `c${Math.random()}`, type, payload }),
    type,
    payload,
  );
  if (!r?.ok) throw new Error(r?.error ?? "no response");
  return r.payload;
};
const configure = (run) =>
  page.evaluate(
    async (run, slot) => {
      const s = (await chrome.storage.sync.get("settings")).settings ?? {};
      await chrome.storage.sync.set({
        settings: {
          ...s,
          settingsVersion: 2,
          mode: "ensemble",
          fusion: { detectors: [run.detector], method: "weighted" },
          useWebGPU: run.device === "webgpu",
          consentedDownload: true,
        },
      });
      const dt = {};
      if (run.dtype) for (const sl of [slot].flat()) dt[sl] = run.dtype;
      await chrome.storage.local.set({ ladDevWebgpuDtypes: dt });
    },
    run,
    SLOT[run.detector],
  );

for (const run of RUNS) {
  const rr = (results.runs[run.key] ??= { device: run.device, detector: run.detector, dtype: run.dtype ?? null, texts: {} });
  // The constants the scores were mapped with, per run (needed to invert them; runs from different builds can be merged).
  rr.constants = { wasm: WASM_CALIBRATION, webgpu: WEBGPU_CALIBRATION };
  // Flip the device off and on so the host unloads sessions bound to the old device/dtype.
  await configure({ ...run, device: run.device === "webgpu" ? "wasm" : "webgpu" });
  await configure(run);
  const t0 = Date.now();
  let n = 0;
  let nWords = 0;
  for (const it of items) {
    if (rr.texts[it.id] && !rr.texts[it.id].error) continue;
    const blocks = toBlocks(it.text);
    let res;
    try {
      res = await send("analyze", { tabId: -1, mode: "ensemble", blocks });
    } catch (e) {
      console.error(`${run.key} ${it.id}: ${e.message}`);
      rr.texts[it.id] = { error: String(e.message).slice(0, 200) };
      continue;
    }
    const det = res.detectors?.[0];
    const paras = blocks.map((b) => {
      const s = res.sentences.find((x) => x.blockId === b.id);
      return [words(b.text), s ? +s.score.toFixed(6) : null];
    });
    rr.texts[it.id] = { doc: det ? +det.overall.toFixed(6) : null, device: det?.device, dtype: det?.dtype, words: res.words, paras };
    rr.ranOn = det?.device;
    rr.ranDtype = det?.dtype;
    n++;
    nWords += res.words ?? 0;
    if (n % 100 === 0) {
      save();
      console.error(`${run.key}: ${n} texts, ${((Date.now() - t0) / n).toFixed(0)} ms/text`);
    }
  }
  if (n) rr.msPer1kWords = +(((Date.now() - t0) / Math.max(1, nWords)) * 1000).toFixed(0);
  save();
  console.error(`${run.key}: done (${n} new; ran on ${rr.ranOn} ${rr.ranDtype}; ${rr.msPer1kWords} ms per 1k words)`);
}
await page.evaluate(() => chrome.storage.local.remove("ladDevWebgpuDtypes"));
await browser.close();
