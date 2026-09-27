#!/usr/bin/env node
// Paragraph-level ("unit") calibration, run in the real extension in Chrome.
// Sentence colours and the "flagged" count come from paragraph-sized
// pieces of text, which are much noisier than the whole documents the
// document-level constants were fitted on, so they need their own
// thresholds (docs/calibration.md, "Paragraph-level thresholds").
//
//   npm run build:e2e && node scripts/e2e/browser-unit-calibration.mjs [--devices wasm,webgpu]
//
// Texts: the calibration set (split on blank lines) and the cached MAGE
// sample (see scripts/compare-classifiers.mjs), whose single-paragraph texts
// are cut into pseudo-paragraphs of >= 60 words. Each text is analysed as a
// page of paragraphs. The paragraph scores are mapped back to raw statistics
// with the unit constants currently in src/engine/calibration.ts, and the new
// thresholds are placed where ~5% of human paragraphs score higher.

import { readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { chromium } from "playwright";

await import("../lib/ts-hooks.mjs");
const { CALIBRATION, WEBGPU_CALIBRATION } = await import("../../src/engine/calibration.ts");

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const SCRATCH = process.env.LAD_SCRATCH ?? resolve("node_modules/.cache/lad-e2e");
const PROFILE = resolve(opt("--profile", join(SCRATCH, "chrome-profile")));
const OUT = resolve(opt("--out", join(SCRATCH, "browser-unit-calibration.json")));
const DEVICES = opt("--devices", "wasm,webgpu").split(",");
const FPR = Number(opt("--fpr", "0.05"));
const mageDir = opt("--mage-dir", join(SCRATCH, "nodecache"));
const here = (p) => new URL(p, import.meta.url);

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
/** Paragraphs as they'd appear on a page; one long paragraph -> pieces of >= 60 words. */
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
  return out.filter((p) => words(p) >= 12);
}
const toBlocks = (paras) => paras.map((text, i) => ({ id: `p${i}`, text, sentences: sentencesOf(text) }));

const texts = [
  ...JSON.parse(readFileSync(here("../calibration/human.json"), "utf8")).map((s) => ({ ...s, label: 0, set: "calibration" })),
  ...JSON.parse(readFileSync(here("../calibration/ai.json"), "utf8")).map((s) => ({ ...s, label: 1, set: "calibration" })),
  ...[
    ...new Map(
      readdirSync(mageDir)
        .filter((f) => /^mage-test-.*\.json$/.test(f))
        .flatMap((f) => JSON.parse(readFileSync(join(mageDir, f), "utf8")))
        .map((r) => [r.text, { ...r, set: "mage" }]),
    ).values(),
  ],
].map((t) => ({ ...t, blocks: toBlocks(toParagraphs(t.text)) }));

for (const d of ["ScriptCache", "Database"]) rmSync(join(PROFILE, "Default", "Service Worker", d), { recursive: true, force: true });
const browser = await puppeteer.launch({
  executablePath: chromium.executablePath(),
  headless: true,
  pipe: true,
  enableExtensions: [resolve(".output/chrome-mv3-e2e")],
  userDataDir: PROFILE,
  args: ["--no-first-run"],
});
const swT = await browser.waitForTarget((t) => t.type() === "service_worker");
const origin = swT.url().match(/^chrome-extension:\/\/[^/]+/)[0];
const page = await browser.newPage();
await page.goto(`${origin}/options.html`);
const send = async (type, payload) => {
  const r = await page.evaluate((type, payload) => chrome.runtime.sendMessage({ kind: "request", id: `c${Math.random()}`, type, payload }), type, payload);
  if (!r?.ok) throw new Error(r?.error ?? "no response");
  return r.payload;
};

const logit = (p) => {
  const q = Math.min(1 - 1e-7, Math.max(1e-7, p));
  return Math.log(q / (1 - q));
};
const units = { wasm: [], webgpu: [] }; // {label, set, mode, raw}
for (const device of DEVICES) {
  await page.evaluate(async (on) => {
    const s = (await chrome.storage.sync.get("settings")).settings;
    await chrome.storage.sync.set({ settings: { ...s, useWebGPU: on, consentedDownload: true } });
  }, device === "webgpu");
  const cal = device === "webgpu" ? { ...CALIBRATION, ...WEBGPU_CALIBRATION } : CALIBRATION;
  for (const mode of ["classifier", "classifierLite", "perplexity"]) {
    const t0 = Date.now();
    for (const t of texts) {
      if (!t.blocks.length) continue;
      const r = await send("analyze", { tabId: -1, mode, blocks: t.blocks });
      // One entry per scoring unit: consecutive sentences with the same score.
      let prev = null;
      for (const s of r.sentences) {
        const key = `${s.score}`;
        if (key === prev) continue;
        prev = key;
        let raw;
        if (mode === "perplexity") raw = cal.unit.perplexityTau - logit(s.score) / cal.perplexity.a; // unit log-PPL
        else {
          const c = cal.unit.classifier[mode];
          raw = logit(s.score) / c.slope + c.center; // raw classifier logit
        }
        units[device].push({ label: t.label, set: t.set, mode, raw });
      }
    }
    console.error(`${device}/${mode}: ${Date.now() - t0} ms`);
  }
}
await page.evaluate(async () => {
  const s = (await chrome.storage.sync.get("settings")).settings;
  await chrome.storage.sync.set({ settings: { ...s, useWebGPU: false } });
});
await browser.close();

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
function auroc(ai, human) {
  let w = 0;
  for (const a of ai) for (const h of human) w += a > h ? 1 : a === h ? 0.5 : 0;
  return w / (ai.length * human.length);
}
const report = { fpr: FPR, fitted: {}, stats: {} };
for (const device of DEVICES) {
  for (const mode of ["classifier", "classifierLite", "perplexity"]) {
    const us = units[device].filter((u) => u.mode === mode);
    const sign = mode === "perplexity" ? -1 : 1; // low log-PPL = AI
    const h = us.filter((u) => u.label === 0).map((u) => sign * u.raw);
    const a = us.filter((u) => u.label === 1).map((u) => sign * u.raw);
    const thr = quantile(h, 1 - FPR);
    report.fitted[`${device}/${mode}`] = +(sign * thr).toFixed(3);
    report.stats[`${device}/${mode}`] = {
      humanUnits: h.length,
      aiUnits: a.length,
      auroc: +auroc(a, h).toFixed(3),
      tprAtThreshold: +(a.filter((x) => x > thr).length / a.length).toFixed(3),
    };
  }
}
writeFileSync(OUT, JSON.stringify({ ...report, units }, null, 2));
console.log(JSON.stringify(report, null, 1));
