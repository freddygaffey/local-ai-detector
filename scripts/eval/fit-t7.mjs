#!/usr/bin/env node
// Fits and reports the T7 calibration from a browser run
// (scripts/e2e/browser-t7-calibration.mjs) over the web eval set
// (scripts/eval/build-eval-set.mjs):
//  - per detector and device: document- and paragraph-level operating points
//    (each detector's 0.5 = ~5% of human texts score higher), on the "fit" half;
//  - Fusion weights (logistic regression on the detectors' log-odds);
//  - display curves (isotonic, score -> P(AI), 50/50 mix) per detector set,
//    device and length, and the slop-filter threshold (~1% human FPR);
//  - every reported number on the held-out "test" half, per genre.
//
//   node scripts/eval/fit-t7.mjs --eval eval-set.json --runs runs.json [--node-dir dir] \
//     [--out fit.json] [--md report.md] [--emit]     (--emit writes src/shared/displayCalibration.ts)

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auroc, displayCurve, ece, fmt, interp, logit, logreg, pct, rates, sigmoid, thresholdAtFpr, tprAtFpr } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const items = JSON.parse(readFileSync(opt("--eval"), "utf8"));
const runs = JSON.parse(readFileSync(opt("--runs"), "utf8"));
const nodeDir = opt("--node-dir");
const byId = new Map(items.map((r) => [r.id, r]));
const md = [];
const out = { constants: {}, weights: {}, curves: {}, metrics: {} };
const P = (...s) => md.push(s.join(""));

const DETS = ["tmr", "lite", "modernbert", "perplexity", "binoculars"];
const SLOT = { tmr: "classifier", lite: "classifierLite", modernbert: "classifierModernBert" };
const GENRES = ["forum", "answer", "review", "news", "blog", "social", "story", "essay", "email"];
const SHORT = 150;
const FLAG_FPR = 0.05;
const FILTER_FPR = 0.01;

// ---------------- Node ranking (optional) ----------------
if (nodeDir && existsSync(nodeDir)) {
  const files = readdirSync(nodeDir).filter((f) => /^scores-.*\.json$/.test(f));
  P("## Candidate ranking (Node, CPU, raw scores, test half)\n");
  P("AUROC per genre; last columns: all genres pooled, and TPR at 1% / 5% human FPR (pooled).\n");
  P(`| Detector | ${GENRES.filter((g) => g !== "email").join(" | ")} | short (<${SHORT} w) | long | all | TPR@1% | TPR@5% | ms/text |`);
  P(`|---|${GENRES.filter((g) => g !== "email").map(() => "---").join("|")}|---|---|---|---|---|---|`);
  out.metrics.node = {};
  for (const f of files) {
    const j = JSON.parse(readFileSync(join(nodeDir, f), "utf8"));
    const sign = j.detector === "perplexity" || j.detector === "binoculars" ? -1 : 1;
    const rows = items.filter((r) => r.split === "test" && Number.isFinite(j.scores[r.id]) && r.set !== "mage");
    const sc = (rs) => rs.map((r) => sign * j.scores[r.id]);
    const lb = (rs) => rs.map((r) => r.label);
    const cell = (rs) => fmt(auroc(sc(rs), lb(rs)));
    const g = GENRES.filter((x) => x !== "email").map((x) => cell(rows.filter((r) => r.genre === x)));
    const m = {
      all: auroc(sc(rows), lb(rows)),
      tpr1: tprAtFpr(sc(rows), lb(rows), 0.01),
      tpr5: tprAtFpr(sc(rows), lb(rows), 0.05),
    };
    out.metrics.node[j.detector] = m;
    P(`| ${j.detector} | ${g.join(" | ")} | ${cell(rows.filter((r) => r.words < SHORT))} | ${cell(rows.filter((r) => r.words >= SHORT))} | **${fmt(m.all)}** | ${pct(m.tpr1)} | ${pct(m.tpr5)} | ${fmt(j.msPerText, 0)} |`);
  }
  P("");
}

// ---------------- browser runs -> raw statistics ----------------
function invert(det, p, cal, level) {
  if (!Number.isFinite(p)) return NaN;
  const L = logit(p);
  if (SLOT[det]) {
    const c = level === "unit" ? cal.unit.classifier[SLOT[det]] : cal.classifier[SLOT[det]];
    return L / c.slope + c.center;
  }
  if (det === "perplexity") return (level === "unit" ? cal.unit.perplexityTau : cal.perplexity.tau) - L / cal.perplexity.a;
  return (level === "unit" ? cal.unit.binocularsTau : cal.binoculars.tau) - L / cal.binoculars.k;
}
/** raw -> "AI-ness" orientation (higher = more AI) */
const orient = (det, raw) => (SLOT[det] ? raw : -raw);

const data = {}; // data[device][det] = { doc: Map(id -> raw), para: [{id, words, raw}] , dtype }
for (const [key, r] of Object.entries(runs.runs)) {
  if (key.includes("@") && !opt("--include-dtype-runs")) continue;
  const cal = runs.constants[r.device];
  const d = ((data[r.device] ??= {})[r.detector] = { doc: new Map(), para: [], dtype: r.ranDtype, ranOn: r.ranOn, ms: r.msPer1kWords });
  for (const [id, t] of Object.entries(r.texts)) {
    if (t.error || t.doc === null) continue;
    d.doc.set(id, invert(r.detector, t.doc, cal, "doc"));
    for (const [w, p] of t.paras) if (p !== null) d.para.push({ id, words: w, raw: invert(r.detector, p, cal, "unit") });
  }
}

// ---------------- fit operating points ----------------
const KEEP_SLOPE = { tmr: 1.27, lite: 1.72, perplexity: 2.0, binoculars: 10 };
function fitDetector(device, det) {
  const d = data[device]?.[det];
  if (!d) return null;
  const fitRows = items.filter((r) => r.split === "fit" && d.doc.has(r.id) && r.set !== "mage");
  const x = fitRows.map((r) => orient(det, d.doc.get(r.id)));
  const y = fitRows.map((r) => r.label);
  const thr = thresholdAtFpr(x, y, FLAG_FPR);
  const paras = d.para.filter((p) => byId.get(p.id)?.split === "fit" && byId.get(p.id)?.set !== "mage" && p.words >= 12);
  const ux = paras.map((p) => orient(det, p.raw));
  const uy = paras.map((p) => byId.get(p.id).label);
  const uthr = thresholdAtFpr(ux, uy, FLAG_FPR);
  let slope = KEEP_SLOPE[det];
  if (slope === undefined) {
    // New detector: logistic slope on the raw statistic, clipped to [1, 2] (see calibration.md "Slopes").
    const { w } = logreg(x.map((v) => [v]), y);
    slope = Math.min(2, Math.max(1, w[0]));
  }
  if (SLOT[det]) return { kind: "classifier", center: +thr.toFixed(3), unitCenter: +uthr.toFixed(3), slope: +slope.toFixed(3) };
  return { kind: det, tau: +(-thr).toFixed(3), unitTau: +(-uthr).toFixed(3), slope };
}
function mapRaw(det, raw, c, level) {
  if (!Number.isFinite(raw) || !c) return NaN;
  if (c.kind === "classifier") return sigmoid(c.slope * (raw - (level === "unit" ? c.unitCenter : c.center)));
  return sigmoid(c.slope * ((level === "unit" ? c.unitTau : c.tau) - raw));
}

const devices = Object.keys(data);
for (const dev of devices) {
  out.constants[dev] = {};
  for (const det of DETS) {
    const c = fitDetector(dev, det);
    if (c) out.constants[dev][det] = c;
  }
}

// scores[device][det][id] = mapped doc-level score with the NEW constants
const scores = {};
const paraScores = {};
for (const dev of devices) {
  scores[dev] = {};
  paraScores[dev] = {};
  for (const det of Object.keys(out.constants[dev])) {
    const c = out.constants[dev][det];
    const d = data[dev][det];
    scores[dev][det] = Object.fromEntries([...d.doc.entries()].map(([id, raw]) => [id, mapRaw(det, raw, c, "doc")]));
    // paragraph as a standalone text: doc-level mapping of the paragraph statistic (for MIN_WORDS)
    paraScores[dev][det] = d.para.map((p) => ({ ...p, doc: mapRaw(det, p.raw, c, "doc"), unit: mapRaw(det, p.raw, c, "unit") }));
  }
}

// ---------------- fusion ----------------
function fuse(ps, ws, method) {
  const s = ps.map((p, i) => [p, ws[i]]).filter(([p]) => Number.isFinite(p));
  if (!s.length) return NaN;
  if (s.length === 1) return s[0][0];
  if (method === "max") return Math.max(...s.map((x) => x[0]));
  if (method === "logodds") return sigmoid(s.reduce((a, x) => a + logit(x[0]), 0) / s.length);
  if (method === "vote") {
    const v = s.map((x) => x[0]).sort((a, b) => a - b);
    return v.length % 2 ? v[(v.length - 1) / 2] : v[v.length / 2 - 1];
  }
  const den = s.reduce((a, x) => a + x[1], 0);
  return s.reduce((a, x) => a + x[0] * x[1], 0) / den;
}

const PRIMARY = devices.includes("webgpu") ? "webgpu" : devices[0];
for (const dev of devices) {
  const avail = DETS.filter((d) => scores[dev][d]);
  const fitRows = items.filter((r) => r.split === "fit" && r.set !== "mage" && avail.every((d) => Number.isFinite(scores[dev][d][r.id])));
  const lrDets = avail;
  const { w } = logreg(fitRows.map((r) => lrDets.map((d) => logit(scores[dev][d][r.id]))), fitRows.map((r) => r.label));
  const raw = Object.fromEntries(lrDets.map((d, i) => [d, Math.max(0.05, w[i])]));
  const mx = Math.max(...Object.values(raw));
  out.weights[dev] = Object.fromEntries(DETS.map((d) => [d, +((raw[d] ?? 0.05 * mx) / mx).toFixed(3)]));
}

const presets = {
  recommended: null, // filled after choosing
  fast: { detectors: ["lite", "perplexity"], method: "weighted" },
  classic: { detectors: ["tmr", "perplexity"], method: "weighted" },
  everything: { detectors: ["tmr", "modernbert", "lite", "perplexity", "binoculars"], method: "weighted" },
};
const profileKey = (dets, method) => (dets.length === 1 ? dets[0] : `${[...dets].sort().join("+")}|${method}`);
function fusedScore(dev, dets, method, id) {
  return fuse(dets.map((d) => scores[dev][d]?.[id]), dets.map((d) => out.weights[dev][d]), method);
}

// Evaluate every subset (2..5 detectors) x method on the fit half -> pick the default.
const allSets = [];
const availP = DETS.filter((d) => scores[PRIMARY][d]);
for (let mask = 1; mask < 1 << availP.length; mask++) {
  const dets = availP.filter((_, i) => mask & (1 << i));
  for (const method of dets.length > 1 ? ["weighted", "logodds", "vote", "max"] : ["weighted"]) allSets.push({ dets, method });
}
function evalSet(dev, dets, method, split, filter = () => true) {
  const rows = items.filter((r) => r.split === split && r.set !== "mage" && filter(r));
  const s = rows.map((r) => fusedScore(dev, dets, method, r.id));
  const y = rows.map((r) => r.label);
  const at = rates(s, y, 0.5);
  return { auroc: auroc(s, y), tpr: at.tpr, fpr: at.fpr, precision: at.precision, tpr1: tprAtFpr(s, y, 0.01), n: rows.length };
}
const ranked = allSets
  .map((x) => ({ ...x, fit: evalSet(PRIMARY, x.dets, x.method, "fit") }))
  .filter((x) => Number.isFinite(x.fit.auroc));
ranked.sort((a, b) => b.fit.tpr1 + b.fit.auroc - (a.fit.tpr1 + a.fit.auroc));
out.ranking = ranked.slice(0, 25).map((x) => ({ key: profileKey(x.dets, x.method), ...x.fit }));
const forced = opt("--default");
let best;
if (forced) {
  const [ds, m] = forced.split("|");
  best = { dets: ds.split("+"), method: m ?? "weighted" };
} else {
  // Prefer sets without Binoculars (slow, CPU-only) unless it wins clearly.
  const noBino = ranked.find((x) => !x.dets.includes("binoculars") && x.dets.length > 1);
  best = noBino;
}
presets.recommended = { detectors: best.dets, method: best.method };
out.defaultFusion = presets.recommended;
const defaultKey = profileKey(best.dets, best.method);

// ---------------- display curves, filter threshold ----------------
const profiles = new Map();
for (const d of availP) profiles.set(profileKey([d], "weighted"), { dets: [d], method: "weighted" });
for (const p of Object.values(presets)) {
  const dets = p.detectors.filter((d) => availP.includes(d));
  if (dets.length) profiles.set(profileKey(dets, p.method), { dets, method: p.method });
}
for (const m of ["logodds", "vote", "max"]) profiles.set(profileKey(best.dets, m), { dets: best.dets, method: m });

const curveFor = (dev, dets, method, len) => {
  const rows = items.filter(
    (r) => r.split === "fit" && r.set !== "mage" && (len === "short" ? r.words < SHORT : r.words >= SHORT),
  );
  const s = rows.map((r) => fusedScore(dev, dets, method, r.id));
  const keep = s.map((v, i) => [v, rows[i].label]).filter(([v]) => Number.isFinite(v));
  return displayCurve(keep.map((k) => k[0]), keep.map((k) => k[1]));
};
for (const dev of devices) {
  const pooledX = { short: [], long: [] };
  for (const [key, p] of profiles) {
    if (!p.dets.every((d) => scores[dev][d])) continue;
    for (const len of ["short", "long"]) {
      out.curves[`${key}|${dev}|${len}`] = curveFor(dev, p.dets, p.method, len);
      const rows = items.filter((r) => r.split === "fit" && r.set !== "mage" && (len === "short" ? r.words < SHORT : r.words >= SHORT));
      for (const r of rows) pooledX[len].push([fusedScore(dev, p.dets, p.method, r.id), r.label]);
    }
  }
  for (const len of ["short", "long"]) {
    const k = pooledX[len].filter(([v]) => Number.isFinite(v));
    out.curves[`pooled|${dev}|${len}`] = displayCurve(k.map((x) => x[0]), k.map((x) => x[1]));
  }
}
const displayP = (dev, key, score, words) => {
  const c = out.curves[`${key}|${dev}|${words < SHORT ? "short" : "long"}`] ?? out.curves[`pooled|${dev}|${words < SHORT ? "short" : "long"}`];
  return interp(c, score);
};

// filter threshold: ~1% human FPR for the default Fusion AND the auto-run lite pass, on the primary device (fit half)
function filterThr(dets, method) {
  const rows = items.filter((r) => r.split === "fit" && r.set !== "mage");
  return thresholdAtFpr(rows.map((r) => fusedScore(PRIMARY, dets, method, r.id)), rows.map((r) => r.label), FILTER_FPR);
}
const thrDefault = filterThr(best.dets, best.method);
const thrLite = scores[PRIMARY].lite ? filterThr(["lite"], "weighted") : thrDefault;
out.filterThreshold = +Math.max(0.5, thrDefault, thrLite).toFixed(3);
out.filterThresholdBy = { default: thrDefault, lite: thrLite };

// ---------------- MIN_WORDS: paragraph-as-text AUROC and ECE by length ----------------
const BINS = [[12, 20], [20, 30], [30, 50], [50, 80], [80, 150], [150, 1e9]];
out.byLength = {};
for (const det of ["lite", ...best.dets.filter((d) => d !== "lite")]) {
  const ps = paraScores[PRIMARY][det];
  if (!ps) continue;
  out.byLength[det] = BINS.map(([a, b]) => {
    const rs = ps.filter((p) => p.words >= a && p.words < b && byId.get(p.id)?.set !== "mage");
    return { bin: `${a}-${b >= 1e9 ? "" : b}`, n: rs.length, auroc: auroc(rs.map((p) => p.doc), rs.map((p) => byId.get(p.id).label)) };
  });
}
// Minimum words: the smallest bin edge from which the default set (paragraph proxy) keeps AUROC >= 0.75.
{
  const ref = out.byLength[best.dets.find((d) => out.byLength[d]) ?? "lite"] ?? [];
  let min = 30;
  for (let i = ref.length - 1; i >= 0; i--) {
    if (ref[i].auroc >= 0.75) min = Number(ref[i].bin.split("-")[0]);
    else break;
  }
  out.minWordsForScore = Math.max(20, min);
}

// ---------------- report (test half) ----------------
function reportTable(title, profilesToShow, dev) {
  P(`### ${title}\n`);
  P("Test half. AUROC per genre, then at the flag point (score ≥ 0.5): human texts flagged (FPR) / AI texts flagged (TPR); at the slop-filter threshold: precision / recall; ECE of the displayed probability.\n");
  P(`| Detector set | ${GENRES.join(" | ")} | short | long | **all** | flag FPR / TPR | filter precision / recall | ECE |`);
  P(`|---|${GENRES.map(() => "---").join("|")}|---|---|---|---|---|---|`);
  for (const [name, p] of profilesToShow) {
    if (!p.dets.every((d) => scores[dev][d])) continue;
    const key = profileKey(p.dets, p.method);
    const rowsAll = items.filter((r) => r.split === "test" && r.set !== "mage");
    const s = (rs) => rs.map((r) => fusedScore(dev, p.dets, p.method, r.id));
    const y = (rs) => rs.map((r) => r.label);
    const cell = (rs) => {
      const a = auroc(s(rs), y(rs));
      if (Number.isFinite(a)) return fmt(a);
      const t = rates(s(rs), y(rs), 0.5);
      return rs.length ? `TPR ${pct(t.tpr)}` : "–";
    };
    const g = GENRES.map((x) => cell(rowsAll.filter((r) => r.genre === x)));
    const at = rates(s(rowsAll), y(rowsAll), 0.5);
    const fl = rates(s(rowsAll), y(rowsAll), out.filterThreshold);
    const probs = rowsAll.map((r) => displayP(dev, key, fusedScore(dev, p.dets, p.method, r.id), r.words));
    const e = ece(probs, y(rowsAll));
    out.metrics[`${dev}|${key}`] = { auroc: auroc(s(rowsAll), y(rowsAll)), fpr: at.fpr, tpr: at.tpr, filterPrecision: fl.precision, filterRecall: fl.tpr, filterFpr: fl.fpr, ece: e.ece, reliability: e.table, byGenre: Object.fromEntries(GENRES.map((x, i) => [x, g[i]])) };
    P(`| ${name} | ${g.join(" | ")} | ${cell(rowsAll.filter((r) => r.words < SHORT))} | ${cell(rowsAll.filter((r) => r.words >= SHORT))} | **${fmt(auroc(s(rowsAll), y(rowsAll)))}** | ${pct(at.fpr)} / ${pct(at.tpr)} | ${pct(fl.precision)} / ${pct(fl.tpr)} | ${fmt(e.ece, 3)} |`);
  }
  P("");
}
const showList = [
  ...availP.map((d) => [d, { dets: [d], method: "weighted" }]),
  [`**Default Fusion** (${best.dets.join(" + ")}, ${best.method})`, { dets: best.dets, method: best.method }],
  ...["logodds", "vote", "max"].map((m) => [`Default set, ${m}`, { dets: best.dets, method: m }]),
  ["Classic (tmr + perplexity)", { dets: ["tmr", "perplexity"], method: "weighted" }],
  ["Fast (lite + perplexity)", { dets: ["lite", "perplexity"], method: "weighted" }],
];
for (const dev of devices) reportTable(`Browser, ${dev}`, showList, dev);

// Precision / recall per genre at the filter threshold, default and lite
P(`### Slop filter (score ≥ ${out.filterThreshold}), ${PRIMARY}, test half\n`);
P("| Genre | Default Fusion: precision / recall / human FPR | Lite (auto-run): precision / recall / human FPR |");
P("|---|---|---|");
for (const g of GENRES) {
  const rs = items.filter((r) => r.split === "test" && r.set !== "mage" && r.genre === g);
  const y = rs.map((r) => r.label);
  const f = (dets, m) => {
    const t = rates(rs.map((r) => fusedScore(PRIMARY, dets, m, r.id)), y, out.filterThreshold);
    return `${pct(t.precision)} / ${pct(t.tpr)} / ${pct(t.fpr)}`;
  };
  P(`| ${g} | ${f(best.dets, best.method)} | ${scores[PRIMARY].lite ? f(["lite"], "weighted") : "–"} |`);
}
P("");

// Stories and modern generators, spelled out
P(`### Stories (test half, ${PRIMARY})\n`);
P("| Source | n AI | Default Fusion: AI flagged (≥ 0.5) | mean shown P(AI) | Lite: AI flagged |");
P("|---|---|---|---|---|");
const storySources = [...new Set(items.filter((r) => r.genre === "story" && r.label === 1).map((r) => (r.set === "llmtrace" ? `LLMTrace ${/gpt|o1|o3/i.test(r.generator) ? "OpenAI (GPT-4o/4.1/o-series)" : "other models"}` : r.set)))];
for (const src of storySources) {
  const rs = items.filter((r) => r.genre === "story" && r.label === 1 && r.split === "test" && (r.set === "llmtrace" ? `LLMTrace ${/gpt|o1|o3/i.test(r.generator) ? "OpenAI (GPT-4o/4.1/o-series)" : "other models"}` : r.set) === src);
  const s = rs.map((r) => fusedScore(PRIMARY, best.dets, best.method, r.id));
  const sl = rs.map((r) => fusedScore(PRIMARY, ["lite"], "weighted", r.id));
  const disp = rs.map((r, i) => displayP(PRIMARY, defaultKey, s[i], r.words)).filter(Number.isFinite);
  P(`| ${src} | ${rs.length} | ${pct(s.filter((v) => v >= 0.5).length / Math.max(1, rs.length))} | ${pct(disp.reduce((a, b) => a + b, 0) / Math.max(1, disp.length))} | ${pct(sl.filter((v) => v >= 0.5).length / Math.max(1, rs.length))} |`);
}
P("");

P(`### Paragraph-as-text AUROC by length (${PRIMARY}, all halves)\n`);
P(`| Detector | ${BINS.map(([a, b]) => `${a}–${b >= 1e9 ? "" : b} w`).join(" | ")} |`);
P(`|---|${BINS.map(() => "---").join("|")}|`);
for (const [det, rows] of Object.entries(out.byLength)) P(`| ${det} | ${rows.map((r) => `${fmt(r.auroc)} (${r.n})`).join(" | ")} |`);
P("");

P("### Reliability, default Fusion (test half)\n");
for (const dev of devices) {
  const m = out.metrics[`${dev}|${defaultKey}`];
  if (!m) continue;
  P(`${dev}: ECE ${fmt(m.ece, 3)}. Shown P(AI) → fraction really AI (n): ${m.reliability.map((b) => `${pct(b.meanP)} → ${pct(b.fracAI)} (${b.n})`).join(", ")}\n`);
}

P("### Constants\n");
P("```json\n" + JSON.stringify({ constants: out.constants, weights: out.weights, defaultFusion: out.defaultFusion, filterThreshold: out.filterThreshold, minWordsForScore: out.minWordsForScore }, null, 1) + "\n```\n");
P("### Top detector sets (fit half, " + PRIMARY + ")\n");
P("| Set | AUROC | TPR@1% FPR | FPR / TPR at 0.5 |");
P("|---|---|---|---|");
for (const r of out.ranking.slice(0, 12)) P(`| ${r.key} | ${fmt(r.auroc)} | ${pct(r.tpr1)} | ${pct(r.fpr)} / ${pct(r.tpr)} |`);

if (opt("--out")) writeFileSync(opt("--out"), JSON.stringify(out, null, 1));
if (opt("--md")) writeFileSync(opt("--md"), md.join("\n"));
console.log(md.join("\n"));

if (args.includes("--emit")) {
  const file = new URL("../../src/shared/displayCalibration.ts", import.meta.url);
  const curves = Object.fromEntries(Object.entries(out.curves).sort());
  const ts = `// GENERATED by scripts/eval/fit-t7.mjs from the T7 browser calibration run
// (docs/calibration.md, "Display probability"). Do not edit by hand.
// Piecewise-linear isotonic curves: engine score -> P(AI) on web text with
// a 50/50 human/AI mix, per detector set | device | length.

export interface DisplayCurve {
  x: number[];
  y: number[];
}

export const DISPLAY_FIT = {
  filterThreshold: ${out.filterThreshold},
  minWordsForScore: ${out.minWordsForScore},
  shortTextWords: ${SHORT},
  defaultProfile: ${JSON.stringify(defaultKey)},
};

export const DISPLAY_CURVES: Record<string, DisplayCurve> = {
${Object.entries(curves).map(([k, c]) => `  ${JSON.stringify(k)}: { x: ${JSON.stringify(c.x)}, y: ${JSON.stringify(c.y)} },`).join("\n")}
};
`;
  writeFileSync(file, ts);
  console.error("wrote", file.pathname);
}
