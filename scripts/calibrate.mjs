#!/usr/bin/env node
// Rough calibration of the engine's detectors on a small labelled sample.
//
//   node scripts/calibrate.mjs [--cache <dir>] [--out <file.json>] [--skip-binoculars]
//
// Runs the real engine code (src/engine/*.ts, via Node's type stripping and
// scripts/lib/ts-hooks.mjs) with transformers.js on CPU against the pinned
// default models, over:
//   scripts/calibration/human.json  public-domain Project Gutenberg excerpts
//   scripts/calibration/ai.json     AI-style texts written for this repo by an LLM
// and prints raw statistics, fitted mapping parameters for the perplexity and
// Binoculars detectors, and an ensemble-weight sweep. Copy the chosen numbers
// into src/engine/calibration.ts and docs/calibration.md by hand.
//
// This is a sanity calibration on ~40 texts, NOT a benchmark. The human
// sample is 19th-century literature, which is far easier to tell apart from
// modern LLM prose than modern human writing is. See docs/calibration.md.
//
// First run downloads ~600 MB of models into --cache (default:
// node_modules/@huggingface/transformers/.cache).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

await import("./lib/ts-hooks.mjs");
const { initRuntime } = await import("../src/engine/runtime.ts");
const { loadModel } = await import("../src/engine/loader.ts");
const { analyzeBlocks } = await import("../src/engine/detect.ts");
const { DEFAULT_MODELS, slotsForMode } = await import("../src/engine/models.ts");
const { sigmoid } = await import("../src/engine/scoring.ts");

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const cacheDir = opt("--cache");
const outFile = opt("--out");
const skipBinoculars = args.includes("--skip-binoculars");

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const human = JSON.parse(readFileSync(here("./calibration/human.json"), "utf8"));
const ai = JSON.parse(readFileSync(here("./calibration/ai.json"), "utf8"));
const samples = [
  ...human.map((s) => ({ ...s, label: 0 })),
  ...ai.map((s) => ({ ...s, label: 1 })),
];

await initRuntime({ cacheDir });

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

const modes = ["classifier", "classifierLite", "perplexity", ...(skipBinoculars ? [] : ["binoculars"])];
const loaded = {};
async function modelsFor(mode) {
  const out = {};
  for (const slot of slotsForMode(mode)) {
    const spec = DEFAULT_MODELS[slot];
    out[slot] = loaded[slot] ??= await loadModel(slot, { repo: spec.repo, revision: spec.revision });
  }
  return out;
}

const rows = [];
for (const s of samples) {
  const blocks = toBlocks(s.text);
  const row = { source: s.source, label: s.label };
  for (const mode of modes) {
    const { stats } = await analyzeBlocks(blocks, { mode, minWords: 50, maxTokens: 4096 }, await modelsFor(mode));
    row.words = stats.words;
    // Raw model probabilities (before any recalibration in calibration.ts).
    if (mode === "classifier") row.classifier = stats.classifierRaw;
    if (mode === "classifierLite") row.classifierLite = stats.classifierRaw;
    if (mode === "perplexity") {
      row.logPPL = stats.logPPL;
      row.burstiness = stats.burstiness;
    }
    if (mode === "binoculars") row.binoculars = stats.binoculars;
  }
  rows.push(row);
  process.stderr.write(".");
}
process.stderr.write("\n");

// ---------- metrics ----------
function auroc(scores, labels) {
  // P(score_ai > score_human), ties count half.
  let win = 0;
  let n = 0;
  scores.forEach((si, i) => {
    if (labels[i] !== 1) return;
    scores.forEach((sj, j) => {
      if (labels[j] !== 0) return;
      n++;
      if (si > sj) win++;
      else if (si === sj) win += 0.5;
    });
  });
  return n ? win / n : NaN;
}
const acc = (probs, labels, t = 0.5) => probs.filter((p, i) => (p >= t ? 1 : 0) === labels[i]).length / probs.length;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));

/** L2-regularised logistic regression on standardised features. Returns raw-space weights. */
function fitLogistic(X, y, lambda = 0.1, iters = 5000, lr = 0.1) {
  const d = X[0].length;
  const mu = Array.from({ length: d }, (_, k) => mean(X.map((r) => r[k])));
  const sd = Array.from({ length: d }, (_, k) => std(X.map((r) => r[k])) || 1);
  const Z = X.map((r) => r.map((v, k) => (v - mu[k]) / sd[k]));
  let b0 = 0;
  const w = new Array(d).fill(0);
  for (let it = 0; it < iters; it++) {
    let g0 = 0;
    const g = new Array(d).fill(0);
    Z.forEach((z, i) => {
      const p = sigmoid(b0 + z.reduce((a, v, k) => a + v * w[k], 0));
      const e = p - y[i];
      g0 += e;
      z.forEach((v, k) => (g[k] += e * v));
    });
    b0 -= (lr * g0) / Z.length;
    w.forEach((_, k) => (w[k] -= lr * (g[k] / Z.length + lambda * w[k])));
  }
  // raw-space: z = c + sum(beta_k * x_k)
  const beta = w.map((wk, k) => wk / sd[k]);
  const c = b0 - w.reduce((a, wk, k) => a + (wk * mu[k]) / sd[k], 0);
  return { c, beta, mu };
}

const labels = rows.map((r) => r.label);
const report = { n: rows.length, human: human.length, ai: ai.length, detectors: {}, fitted: {} };

// Classifiers: raw metrics, then a logit-space recalibration
// p' = sigmoid(slope * (logit(p) - center)), with the slope capped so a
// near-separable tiny sample can't produce a knife-edge threshold.
const SLOPE_CAP = 2;
const logit = (p) => {
  const q = Math.min(1 - 1e-7, Math.max(1e-7, p));
  return Math.log(q / (1 - q));
};
for (const key of ["classifier", "classifierLite"]) {
  const p = rows.map((r) => r[key]);
  const f = fitLogistic(rows.map((r) => [logit(r[key])]), labels, 0.01);
  const slope = Math.min(SLOPE_CAP, f.beta[0]);
  // keep the fitted decision point (z = 0) when capping the slope
  const center = -f.c / f.beta[0];
  const recal = rows.map((r) => sigmoid(slope * (logit(r[key]) - center)));
  rows.forEach((r, i) => (r[key + "Recal"] = recal[i]));
  report.fitted[key] = { center: +center.toFixed(3), slope: +slope.toFixed(3), uncappedSlope: +f.beta[0].toFixed(3) };
  report.detectors[key] = {
    auroc: auroc(p, labels),
    accuracyAt05: acc(p, labels),
    recalibratedAccuracyAt05: acc(recal, labels),
    humanFlaggedAt05: p.filter((x, i) => x >= 0.5 && labels[i] === 0).length,
  };
}

// Perplexity: fit p = sigmoid(a (tau - logPPL) + b (tauBurst - burst)).
const pplRows = rows.filter((r) => Number.isFinite(r.logPPL) && Number.isFinite(r.burstiness));
const Xp = pplRows.map((r) => [r.logPPL, r.burstiness]);
const yp = pplRows.map((r) => r.label);
let fit = fitLogistic(Xp, yp);
let a = -fit.beta[0];
let b = -fit.beta[1];
if (b < 0) {
  // Burstiness pointing the "wrong" way on this sample: drop it rather than invert the intuition.
  fit = fitLogistic(Xp.map((x) => [x[0]]), yp);
  a = -fit.beta[0];
  b = 0;
}
const tauBurst = mean(pplRows.map((r) => r.burstiness));
// c = a*tau + b*tauBurst  ->  tau = (c - b*tauBurst) / a
const tau = (fit.c - b * tauBurst) / a;
const pplParams = { tau: +tau.toFixed(3), a: +a.toFixed(3), tauBurst: +tauBurst.toFixed(3), b: +b.toFixed(3) };
const pplProb = (r) => sigmoid(pplParams.a * (pplParams.tau - r.logPPL) + pplParams.b * (pplParams.tauBurst - r.burstiness));
rows.forEach((r) => (r.perplexityP = pplProb(r)));
report.fitted.perplexity = pplParams;
report.detectors.logPPL_raw = { auroc: auroc(rows.map((r) => -r.logPPL), labels) };
report.detectors.burstiness_raw = { auroc: auroc(rows.map((r) => -r.burstiness), labels) };
report.detectors.perplexity = {
  auroc: auroc(rows.map((r) => r.perplexityP), labels),
  accuracyAt05: acc(rows.map((r) => r.perplexityP), labels),
};

// Leave-one-out accuracy for the perplexity fit (how much is overfitting?).
{
  let correct = 0;
  pplRows.forEach((_, i) => {
    const X = Xp.filter((_, j) => j !== i);
    const y = yp.filter((_, j) => j !== i);
    const f = fitLogistic(X, y, 0.1, 2000);
    const z = f.c + f.beta[0] * Xp[i][0] + f.beta[1] * Xp[i][1];
    if ((sigmoid(z) >= 0.5 ? 1 : 0) === yp[i]) correct++;
  });
  report.detectors.perplexity.leaveOneOutAccuracy = correct / pplRows.length;
}

if (!skipBinoculars) {
  const Xb = rows.map((r) => [r.binoculars]);
  const fb = fitLogistic(Xb, labels);
  const k = -fb.beta[0];
  const tauB = fb.c / k;
  report.fitted.binoculars = { tau: +tauB.toFixed(3), k: +k.toFixed(2) };
  const bp = rows.map((r) => sigmoid(k * (tauB - r.binoculars)));
  report.detectors.binoculars = {
    auroc: auroc(rows.map((r) => -r.binoculars), labels),
    accuracyAt05: acc(bp, labels),
    humanMean: mean(rows.filter((r) => !r.label).map((r) => r.binoculars)),
    aiMean: mean(rows.filter((r) => r.label).map((r) => r.binoculars)),
  };
}

// Ensemble weight sweep.
report.ensembleSweep = [];
for (let wc = 0; wc <= 1.0001; wc += 0.1) {
  const p = rows.map((r) => wc * r.classifierRecal + (1 - wc) * r.perplexityP);
  report.ensembleSweep.push({ wClassifier: +wc.toFixed(1), auroc: auroc(p, labels), accuracyAt05: acc(p, labels) });
}

report.rows = rows;
console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
console.log("\nPer-sample raw stats:");
console.log("label  words  cls    lite   logPPL burst  bino   source");
for (const r of rows) {
  console.log(
    [
      r.label ? "AI   " : "human",
      String(r.words).padStart(5),
      r.classifier.toFixed(3),
      r.classifierLite.toFixed(3),
      r.logPPL.toFixed(3),
      (r.burstiness ?? NaN).toFixed(3),
      (r.binoculars ?? NaN).toFixed(3),
      r.source.slice(0, 60),
    ].join("  "),
  );
}
if (outFile) writeFileSync(outFile, JSON.stringify(report, null, 2));
