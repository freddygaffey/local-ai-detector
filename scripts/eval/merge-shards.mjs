#!/usr/bin/env node
// Merges per-shard outputs of scripts/e2e/browser-t7-calibration.mjs (the CI
// matrix in .github/workflows/t7-eval.yml) into one runs file, and writes
// the eval set's metadata (ids, labels, genres, sources, lengths; no texts).
//
//   node scripts/eval/merge-shards.mjs --out runs.json --eval eval-set.json --meta eval-meta.json shard1.json shard2.json ...

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const files = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const out = { runs: {} };
for (const f of files) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  out.constants ??= j.constants;
  for (const [k, r] of Object.entries(j.runs)) {
    const m = (out.runs[k] ??= { ...r, texts: {}, shards: 0, msPer1kWordsByShard: [] });
    m.shards++;
    if (r.msPer1kWords) m.msPer1kWordsByShard.push(r.msPer1kWords);
    for (const [id, t] of Object.entries(r.texts)) if (!m.texts[id] || m.texts[id].error) m.texts[id] = t;
  }
}
for (const r of Object.values(out.runs)) {
  const ms = r.msPer1kWordsByShard;
  r.msPer1kWords = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null;
  const n = Object.keys(r.texts).length;
  const err = Object.values(r.texts).filter((t) => t.error).length;
  console.log(`${r.device}:${r.detector}: ${n} texts, ${err} errors, ${r.msPer1kWords} ms/1k words`);
}
writeFileSync(opt("--out"), JSON.stringify(out));
if (opt("--eval") && opt("--meta")) {
  const items = JSON.parse(readFileSync(opt("--eval"), "utf8"));
  writeFileSync(opt("--meta"), JSON.stringify(items.map(({ text, ...m }) => m)));
}
