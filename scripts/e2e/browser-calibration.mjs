#!/usr/bin/env node
// Runs the calibration set and the held-out MAGE sample through the REAL
// extension in Chrome (WASM and WebGPU), because browser ONNX Runtime does
// not reproduce Node's numbers exactly (see docs/calibration.md, "Browser vs
// Node"). Reports AUROC / accuracy / FPR / TPR per detector and device with
// the shipping mappings, and refits the mapping constants on the browser's
// own raw outputs (recovered by inverting the shipping mapping).
//
//   npm run build:e2e && node scripts/compare-classifiers.mjs   # creates the MAGE cache
//   node scripts/e2e/browser-calibration.mjs [--profile dir] [--mage file.json] [--out r.json]
//
// Uses the Chrome E2E profile (models already cached there by scripts/e2e/chrome.mjs).

import { readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { chromium } from "playwright";

await import("../lib/ts-hooks.mjs");
const { CALIBRATION } = await import("../../src/engine/calibration.ts");

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const SCRATCH = process.env.LAD_SCRATCH ?? resolve("node_modules/.cache/lad-e2e");
const PROFILE = resolve(opt("--profile", join(SCRATCH, "chrome-profile")));
const OUT = resolve(opt("--out", join(SCRATCH, "browser-calibration.json")));
const mageDir = opt("--mage-dir", join(SCRATCH, "nodecache"));
const mageFiles = readdirSync(mageDir).filter((f) => /^mage-test-.*\.json$/.test(f));
const here = (p) => new URL(p, import.meta.url);

const sets = {
  calibration: [
    ...JSON.parse(readFileSync(here("../calibration/human.json"), "utf8")).map((s) => ({ ...s, label: 0 })),
    ...JSON.parse(readFileSync(here("../calibration/ai.json"), "utf8")).map((s) => ({ ...s, label: 1 })),
  ],
  mage: mageFiles.flatMap((f) => JSON.parse(readFileSync(join(mageDir, f), "utf8"))),
};
// de-duplicate MAGE rows sampled by more than one seed
sets.mage = [...new Map(sets.mage.map((r) => [r.text, r])).values()];

const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
function toBlocks(text) {
  return text.split(/\n\s*\n/).map((para, i) => {
    const sentences = [];
    for (const s of segmenter.segment(para)) {
      const trimmed = s.segment.replace(/\s+$/, "");
      if (trimmed.trim()) sentences.push({ start: s.index, end: s.index + trimmed.length });
    }
    return { id: `p${i}`, text: para, sentences };
  });
}

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
const setGpu = (on) =>
  page.evaluate(async (on) => {
    const s = (await chrome.storage.sync.get("settings")).settings;
    await chrome.storage.sync.set({ settings: { ...s, useWebGPU: on, consentedDownload: true } });
  }, on);

const MODES = ["classifier", "classifierLite", "perplexity"];
const DEVICES = ["wasm", "webgpu"];
const rows = { calibration: [], mage: [] };
for (const [name, items] of Object.entries(sets)) {
  for (const it of items) rows[name].push({ label: it.label, source: it.source, blocks: toBlocks(it.text) });
}
for (const device of DEVICES) {
  await setGpu(device === "webgpu");
  for (const mode of MODES) {
    const t0 = Date.now();
    for (const [name, rs] of Object.entries(rows)) {
      for (const r of rs) {
        const res = await send("analyze", { tabId: -1, mode, blocks: r.blocks });
        r[`${mode}-${device}`] = res.overall;
      }
    }
    const info = await send("getEngineInfo", undefined);
    console.error(`${device}/${mode}: ${Date.now() - t0} ms (engine device ${info.runtime?.device})`);
  }
}
await setGpu(false);
await browser.close();

// ---------------- metrics + refit ----------------
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => {
  const q = Math.min(1 - 1e-7, Math.max(1e-7, p));
  return Math.log(q / (1 - q));
};
function auroc(s, y) {
  let win = 0;
  let n = 0;
  s.forEach((si, i) => {
    if (y[i] !== 1) return;
    s.forEach((sj, j) => {
      if (y[j] !== 0) return;
      n++;
      win += si > sj ? 1 : si === sj ? 0.5 : 0;
    });
  });
  return n ? win / n : NaN;
}
function fit1(x, y, lambda = 0.01, iters = 6000, lr = 0.1) {
  const mu = x.reduce((a, b) => a + b, 0) / x.length;
  const sd = Math.sqrt(x.reduce((a, b) => a + (b - mu) ** 2, 0) / x.length) || 1;
  const z = x.map((v) => (v - mu) / sd);
  let b0 = 0;
  let w = 0;
  for (let it = 0; it < iters; it++) {
    let g0 = 0;
    let g1 = 0;
    z.forEach((zi, i) => {
      const e = sigmoid(b0 + w * zi) - y[i];
      g0 += e;
      g1 += e * zi;
    });
    b0 -= (lr * g0) / z.length;
    w -= lr * (g1 / z.length + lambda * w);
  }
  return { beta: w / sd, c: b0 - (w * mu) / sd };
}
// Raw statistic recovered from the shipping mapping.
const toRaw = {
  classifier: (p) => logit(p) / CALIBRATION.classifier.classifier.slope + CALIBRATION.classifier.classifier.center, // raw logit
  classifierLite: (p) => logit(p) / CALIBRATION.classifier.classifierLite.slope + CALIBRATION.classifier.classifierLite.center,
  perplexity: (p) => CALIBRATION.perplexity.tau - logit(p) / CALIBRATION.perplexity.a, // logPPL (b = 0)
};
const metrics = (s, y) => {
  const fp = s.filter((v, i) => v >= 0.5 && y[i] === 0).length;
  const tp = s.filter((v, i) => v >= 0.5 && y[i] === 1).length;
  const h = y.filter((v) => v === 0).length;
  return {
    auroc: +auroc(s, y).toFixed(3),
    acc: +(s.filter((v, i) => (v >= 0.5 ? 1 : 0) === y[i]).length / s.length).toFixed(3),
    fpr: +(fp / h).toFixed(3),
    tpr: +(tp / (y.length - h)).toFixed(3),
  };
};
const report = { n: { calibration: rows.calibration.length, mage: rows.mage.length }, metrics: {}, refit: {} };
for (const device of DEVICES) {
  for (const [name, rs] of Object.entries(rows)) {
    const y = rs.map((r) => r.label);
    const m = {};
    for (const mode of MODES) m[mode] = metrics(rs.map((r) => r[`${mode}-${device}`]), y);
    for (const cls of ["classifier", "classifierLite"]) {
      const ens = rs.map((r) => (0.7 * r[`${cls}-${device}`] + 0.3 * r[`perplexity-${device}`]));
      m[`ensemble(${cls})`] = metrics(ens, y);
    }
    report.metrics[`${device}/${name}`] = m;
  }
  // Refit on calibration + MAGE together (pooled), per detector.
  const all = [...rows.calibration, ...rows.mage];
  const y = all.map((r) => r.label);
  for (const mode of MODES) {
    const raw = all.map((r) => toRaw[mode](r[`${mode}-${device}`]));
    const f = fit1(raw, y);
    if (mode === "perplexity") {
      const a = -f.beta;
      report.refit[`${device}/${mode}`] = { tau: +(f.c / a).toFixed(3), a: +a.toFixed(3) };
    } else {
      const slope = Math.min(2, f.beta);
      report.refit[`${device}/${mode}`] = { center: +(-f.c / f.beta).toFixed(3), slope: +slope.toFixed(3), uncappedSlope: +f.beta.toFixed(3) };
    }
  }
}
report.rows = Object.fromEntries(Object.entries(rows).map(([k, rs]) => [k, rs.map(({ blocks, ...r }) => r)]));
writeFileSync(OUT, JSON.stringify(report, null, 2));
for (const [k, m] of Object.entries(report.metrics)) {
  console.log(`\n== ${k} ==`);
  for (const [d, v] of Object.entries(m)) console.log(`${d.padEnd(26)} AUROC ${v.auroc}  acc ${v.acc}  FPR ${v.fpr}  TPR ${v.tpr}`);
}
console.log("\nrefit (pooled calibration + MAGE):", JSON.stringify(report.refit, null, 1));
