#!/usr/bin/env node
// Compares the two classifiers (TMR RoBERTa vs e5-small "lite") and the
// ensemble built on each, on:
//   1. the calibration set (scripts/calibration/*.json; in-sample for the
//      mapping constants), and
//   2. a held-out random sample of MAGE (yaful/MAGE, Apache-2.0; test split,
//      many domains and generators, fetched from the HF datasets-server API
//      and cached, never committed). Neither classifier was trained on MAGE.
//   3. optionally, texts from JSON files given with --extra (e.g. the E2E
//      fixture pages: [{label:0|1, source, text}]).
//
//   node scripts/compare-classifiers.mjs [--cache <dir>] [--n 150] [--seed 7] [--extra f.json] [--out r.json]
//
// Uses the shipping mappings in src/engine/calibration.ts (no refitting), so
// the MAGE numbers are an honest out-of-sample check of what users get.
// See docs/calibration.md ("Which classifier the ensemble uses").

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

await import("./lib/ts-hooks.mjs");
const { initRuntime } = await import("../src/engine/runtime.ts");
const { loadModel } = await import("../src/engine/loader.ts");
const { analyzeBlocks } = await import("../src/engine/detect.ts");
const { DEFAULT_MODELS } = await import("../src/engine/models.ts");
const { CALIBRATION } = await import("../src/engine/calibration.ts");
const { perplexityProbability, recalibrateClassifier, blendEnsemble } = await import("../src/engine/scoring.ts");

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : d;
};
const cacheDir = opt("--cache");
const N = Number(opt("--n", "150"));
const seed = Number(opt("--seed", "7"));
const outFile = opt("--out");
const extraFiles = args.flatMap((a, i) => (a === "--extra" ? [args[i + 1]] : []));
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// ---------- data ----------
function rng(s) {
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const words = (t) => t.split(/\s+/).filter(Boolean).length;

async function mageSample() {
  const dir = cacheDir ?? join(here("../node_modules/.cache"), "lad-compare");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `mage-test-${seed}-${N}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const rand = rng(seed);
  const TOTAL = 60743; // rows in yaful/MAGE test
  const human = [];
  const ai = [];
  for (let page = 0; page < 60 && (human.length < N || ai.length < N); page++) {
    const offset = Math.floor(rand() * (TOTAL - 100));
    const url = `https://datasets-server.huggingface.co/rows?dataset=yaful/MAGE&config=default&split=test&offset=${offset}&length=100`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`MAGE fetch ${res.status}`);
    const { rows } = await res.json();
    for (const { row } of rows) {
      const w = words(row.text);
      if (w < 120 || w > 450) continue;
      // MAGE: label 1 = human, 0 = machine.
      const item = { source: `MAGE test: ${row.src}`, text: row.text };
      if (row.label === 1 && human.length < N && rand() < 0.5) human.push({ ...item, label: 0 });
      if (row.label === 0 && ai.length < N && rand() < 0.5) ai.push({ ...item, label: 1 });
    }
    process.stderr.write(`MAGE: ${human.length} human, ${ai.length} AI\r`);
  }
  process.stderr.write("\n");
  const out = [...human, ...ai];
  writeFileSync(file, JSON.stringify(out));
  return out;
}

const calib = [
  ...JSON.parse(readFileSync(here("./calibration/human.json"), "utf8")).map((s) => ({ ...s, label: 0 })),
  ...JSON.parse(readFileSync(here("./calibration/ai.json"), "utf8")).map((s) => ({ ...s, label: 1 })),
];
const sets = { calibration: calib, mage: await mageSample() };
for (const f of extraFiles) sets[f.replace(/^.*\//, "")] = JSON.parse(readFileSync(f, "utf8"));

// ---------- models ----------
await initRuntime({ cacheDir });
const loaded = {};
const model = async (slot) =>
  (loaded[slot] ??= await loadModel(slot, { repo: DEFAULT_MODELS[slot].repo, revision: DEFAULT_MODELS[slot].revision }));

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

async function score(text) {
  const blocks = toBlocks(text);
  const o = { minWords: 50, maxTokens: 4096 };
  const c = (await analyzeBlocks(blocks, { ...o, mode: "classifier" }, { classifier: await model("classifier") })).stats;
  const l = (await analyzeBlocks(blocks, { ...o, mode: "classifierLite" }, { classifierLite: await model("classifierLite") }))
    .stats;
  const p = (await analyzeBlocks(blocks, { ...o, mode: "perplexity" }, { perplexityLM: await model("perplexityLM") })).stats;
  const tmr = recalibrateClassifier(c.classifierRaw, CALIBRATION.classifier.classifier);
  const lite = recalibrateClassifier(l.classifierRaw, CALIBRATION.classifier.classifierLite);
  const ppl = perplexityProbability(p.logPPL, p.burstiness);
  return {
    tmrRaw: c.classifierRaw,
    liteRaw: l.classifierRaw,
    tmr,
    lite,
    ppl,
    ensTmr: blendEnsemble(tmr, ppl),
    ensLite: blendEnsemble(lite, ppl),
    ensBoth: (0.35 * tmr + 0.35 * lite + 0.3 * ppl),
  };
}

// ---------- metrics ----------
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
const KEYS = ["tmrRaw", "liteRaw", "tmr", "lite", "ppl", "ensTmr", "ensLite", "ensBoth"];
const report = {};
for (const [name, items] of Object.entries(sets)) {
  const rows = [];
  for (const it of items) {
    rows.push({ label: it.label, source: it.source, ...(await score(it.text)) });
    process.stderr.write(".");
  }
  process.stderr.write("\n");
  const y = rows.map((r) => r.label);
  const r = { n: rows.length, human: y.filter((v) => v === 0).length, ai: y.filter((v) => v === 1).length, metrics: {} };
  for (const k of KEYS) {
    const s = rows.map((row) => row[k]);
    const thr = k.endsWith("Raw") ? 0.5 : 0.5;
    const fp = s.filter((v, i) => v >= thr && y[i] === 0).length;
    const tp = s.filter((v, i) => v >= thr && y[i] === 1).length;
    r.metrics[k] = {
      auroc: +auroc(s, y).toFixed(3),
      acc: +(s.filter((v, i) => (v >= thr ? 1 : 0) === y[i]).length / s.length).toFixed(3),
      fpr: +(fp / Math.max(1, r.human)).toFixed(3),
      tpr: +(tp / Math.max(1, r.ai)).toFixed(3),
      humanMean: +(s.filter((_, i) => y[i] === 0).reduce((a, b) => a + b, 0) / Math.max(1, r.human)).toFixed(3),
      aiMean: +(s.filter((_, i) => y[i] === 1).reduce((a, b) => a + b, 0) / Math.max(1, r.ai)).toFixed(3),
    };
  }
  // by MAGE source family (human vs machine sources)
  if (name === "mage") {
    const fam = {};
    for (const row of rows) {
      const src = row.source.replace("MAGE test: ", "").replace(/_(human|machine).*$/, "");
      (fam[src] ??= []).push(row);
    }
    r.byDomain = Object.fromEntries(
      Object.entries(fam).map(([k, rs]) => [
        k,
        { n: rs.length, ...Object.fromEntries(["tmr", "lite", "ensTmr", "ensLite"].map((m) => [m, +auroc(rs.map((x) => x[m]), rs.map((x) => x.label)).toFixed(2)])) },
      ]),
    );
  }
  r.rows = rows;
  report[name] = r;
  console.log(`\n== ${name} (n=${r.n}: ${r.human} human, ${r.ai} AI) ==`);
  console.log("metric    AUROC  acc@.5  FPR    TPR    humanMean aiMean");
  for (const k of KEYS) {
    const m = r.metrics[k];
    console.log(
      `${k.padEnd(9)} ${m.auroc.toFixed(3)}  ${m.acc.toFixed(3)}   ${m.fpr.toFixed(3)}  ${m.tpr.toFixed(3)}  ${m.humanMean.toFixed(3)}     ${m.aiMean.toFixed(3)}`,
    );
  }
  if (r.byDomain) console.log("by domain (AUROC):", JSON.stringify(r.byDomain));
}
if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(report, null, 2));
}
