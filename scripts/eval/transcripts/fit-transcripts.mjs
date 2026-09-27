#!/usr/bin/env node
// Reports and fits the transcript calibration (docs/calibration.md
// "Transcripts") from score-transcripts.mjs output.
//
//   node scripts/eval/transcripts/fit-transcripts.mjs --set transcript-set.json \
//        --scores fusion=scores-fusion.json,lite=scores-lite.json \
//        --ship-unpunct pause --md report.md [--emit]
//
// Per condition: AUROC (test half), overall and per human group; flag
// (score >= 0.5) FPR/TPR; filter (>= 0.75) precision/recall. The display
// curve is an isotonic fit of label on engine score (fit half, 50/50 class
// weights), on the shipped path: the "punct" condition plus the chosen
// condition for unpunctuated captions. Long = whole texts (>= 150 words),
// short = single segments under 150 words. --emit writes
// src/shared/transcriptCalibration.ts.

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const items = JSON.parse(readFileSync(opt("--set"), "utf8"));
const byId = new Map(items.map((x) => [x.id, x]));
const runs = Object.fromEntries(
  opt("--scores")
    .split(",")
    .map((kv) => kv.split("="))
    .map(([k, f]) => [k, JSON.parse(readFileSync(f, "utf8")).scores]),
);
const shipUnpunct = opt("--ship-unpunct", "pause");
const PROFILE = { fusion: "fakespot+tmr|weighted", lite: "lite" };

function auroc(pos, neg) {
  if (!pos.length || !neg.length) return NaN;
  const all = [...pos.map((s) => [s, 1]), ...neg.map((s) => [s, 0])].sort((a, b) => a[0] - b[0]);
  let rank = 0;
  let sumPos = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const avg = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (all[k][1]) sumPos += avg;
    rank = j;
    i = j;
  }
  void rank;
  return (sumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "–");
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "–");

function rows(run, cond, split) {
  return Object.entries(run[cond] ?? {})
    .map(([id, r]) => ({ it: byId.get(id), r }))
    .filter((x) => x.it && x.it.split === split && Number.isFinite(x.r.overall));
}

// Weighted pool-adjacent-violators.
function isotonic(points) {
  const pts = [...points].sort((a, b) => a.x - b.x);
  const blocks = [];
  for (const p of pts) {
    blocks.push({ x0: p.x, x1: p.x, sw: p.w, sy: p.y * p.w });
    while (blocks.length > 1 && blocks[blocks.length - 2].sy / blocks[blocks.length - 2].sw >= blocks[blocks.length - 1].sy / blocks[blocks.length - 1].sw) {
      const b = blocks.pop();
      const a = blocks[blocks.length - 1];
      a.x1 = b.x1;
      a.sw += b.sw;
      a.sy += b.sy;
    }
  }
  return blocks.map((b) => ({ x: (b.x0 + b.x1) / 2, y: b.sy / b.sw, w: b.sw }));
}

/** Isotonic fit -> at most `maxKnots` points, shrunk towards 0.5 where data is thin, clipped to [0.03, 0.97]. */
function fitCurve(points, maxKnots = 10) {
  let iso = isotonic(points);
  // Merge neighbouring blocks until few enough knots (keep monotone).
  while (iso.length > maxKnots) {
    let best = 0;
    for (let i = 1; i < iso.length - 1; i++) if (iso[i].w + iso[i + 1].w < iso[best].w + iso[best + 1].w) best = i;
    const a = iso[best];
    const b = iso[best + 1];
    iso.splice(best, 2, { x: (a.x * a.w + b.x * b.w) / (a.w + b.w), y: (a.y * a.w + b.y * b.w) / (a.w + b.w), w: a.w + b.w });
  }
  const k = 4;
  iso = iso.map((p) => ({ ...p, y: (p.y * p.w + 0.5 * k) / (p.w + k) }));
  const xs = [0, ...iso.map((p) => Number(p.x.toFixed(4))), 1];
  const ys = [iso[0].y, ...iso.map((p) => p.y), iso[iso.length - 1].y].map((y) => Number(Math.min(0.97, Math.max(0.03, y)).toFixed(4)));
  // Deduplicate x.
  const X = [];
  const Y = [];
  xs.forEach((x, i) => {
    if (X.length && x <= X[X.length - 1]) return;
    X.push(x);
    Y.push(ys[i]);
  });
  return { x: X, y: Y };
}

function interp(c, x) {
  if (x <= c.x[0]) return c.y[0];
  for (let i = 1; i < c.x.length; i++) if (x <= c.x[i]) return c.y[i - 1] + ((x - c.x[i - 1]) / (c.x[i] - c.x[i - 1] || 1)) * (c.y[i] - c.y[i - 1]);
  return c.y[c.y.length - 1];
}

function balanced(points) {
  const n1 = points.filter((p) => p.y === 1).length;
  const n0 = points.length - n1;
  return points.map((p) => ({ ...p, w: p.y === 1 ? points.length / 2 / n1 : points.length / 2 / n0 }));
}

function ece(points, curve) {
  const bins = Array.from({ length: 10 }, () => ({ w: 0, p: 0, y: 0 }));
  for (const pt of points) {
    const p = interp(curve, pt.x);
    const b = bins[Math.min(9, Math.floor(p * 10))];
    b.w += pt.w;
    b.p += p * pt.w;
    b.y += pt.y * pt.w;
  }
  const tot = bins.reduce((a, b) => a + b.w, 0);
  const e = bins.reduce((a, b) => a + (b.w ? Math.abs(b.p / b.w - b.y / b.w) * b.w : 0), 0) / tot;
  const rel = bins.filter((b) => b.w > 0).map((b) => `${pct(b.p / b.w)} → ${pct(b.y / b.w)} (${Math.round(b.w)})`);
  return { e, rel };
}

const md = [];
const out = {};
for (const [mode, run] of Object.entries(runs)) {
  md.push(`#### ${mode === "fusion" ? "Default Fusion (Fakespot + TMR)" : "Lite (auto-run)"}\n`);
  md.push("| Condition | AUROC all | vs speech | vs human prose | AI: own scripts / web AI flagged | flag FPR / TPR (≥ 0.5) | filter precision / recall (≥ 0.75) |");
  md.push("|---|---|---|---|---|---|---|");
  for (const cond of Object.keys(run)) {
    const test = rows(run, cond, "test");
    const pos = test.filter((x) => x.it.label === 1);
    const neg = test.filter((x) => x.it.label === 0);
    const s = (xs) => xs.map((x) => x.r.overall);
    const sp = neg.filter((x) => x.it.group === "speech");
    const hp = neg.filter((x) => x.it.group === "human-prose");
    const flagged = (xs, t) => xs.filter((x) => x.r.overall >= t).length;
    const own = pos.filter((x) => x.it.group === "ai-script");
    const web = pos.filter((x) => x.it.group === "ai-web");
    const tp75 = flagged(pos, 0.75);
    const fp75 = flagged(neg, 0.75);
    md.push(
      `| ${cond} | **${f2(auroc(s(pos), s(neg)))}** | ${f2(auroc(s(pos), s(sp)))} | ${f2(auroc(s(pos), s(hp)))} | ${pct(flagged(own, 0.5) / own.length)} / ${pct(flagged(web, 0.5) / web.length)} | ${pct(flagged(neg, 0.5) / neg.length)} / ${pct(flagged(pos, 0.5) / pos.length)} | ${tp75 + fp75 ? pct(tp75 / (tp75 + fp75)) : "–"} / ${pct(tp75 / pos.length)} |`,
    );
  }
  md.push(`\n(test half: ${rows(run, Object.keys(run)[0], "test").length} texts)\n`);

  // Display curve on the shipped path.
  const pathConds = ["punct", shipUnpunct].filter((c) => run[c]);
  const pointsFor = (split, len) => {
    const pts = [];
    for (const cond of pathConds) {
      for (const { it, r } of rows(run, cond, split)) {
        if (len === "long") {
          if ((r.words ?? 0) >= 150) pts.push({ x: r.overall, y: it.label });
        } else {
          for (const b of r.blocks ?? []) if (b.score !== null && b.words >= 30 && b.words < 150) pts.push({ x: b.score, y: it.label });
        }
      }
    }
    return balanced(pts);
  };
  for (const len of ["long", "short"]) {
    const fitPts = pointsFor("fit", len);
    const testPts = pointsFor("test", len);
    if (fitPts.length < 20) continue;
    const curve = fitCurve(fitPts);
    out[`${PROFILE[mode]}|${len}`] = curve;
    const { e, rel } = ece(testPts, curve);
    md.push(`Display (${len}, path ${pathConds.join(" + ")}), test ECE **${f2(e)}** (${testPts.length} points): ${rel.join(", ")}\n`);
  }
}

const report = md.join("\n");
console.log(report);
if (opt("--md")) writeFileSync(opt("--md"), report);
if (args.includes("--emit")) {
  const lines = Object.entries(out)
    .sort()
    .map(([k, c]) => `  ${JSON.stringify(k)}: { x: [${c.x.join(",")}], y: [${c.y.join(",")}] },`);
  writeFileSync(
    new URL("../../../src/shared/transcriptCalibration.ts", import.meta.url),
    `// GENERATED by scripts/eval/transcripts/fit-transcripts.mjs from the T10 transcript eval set
// (docs/calibration.md, "Transcripts"). Do not edit by hand.
// Piecewise-linear isotonic curves: engine score -> P(AI) for a YouTube
// transcript with a 50/50 human/AI mix, per detector set | length.

export const TRANSCRIPT_CURVES: Record<string, { x: number[]; y: number[] }> = {
${lines.join("\n")}
};
`,
  );
  console.error("wrote src/shared/transcriptCalibration.ts");
}
