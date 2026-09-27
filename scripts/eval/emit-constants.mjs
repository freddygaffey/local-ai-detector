#!/usr/bin/env node
// Prints the WEBGPU_CALIBRATION / WASM_CALIBRATION objects for
// src/engine/calibration.ts from a scripts/eval/fit-t7.mjs --out JSON, so
// the shipped constants can be pasted (and reviewed) by hand.
//
//   node scripts/eval/emit-constants.mjs fit.json

import { readFileSync } from "node:fs";

const fit = JSON.parse(readFileSync(process.argv[2], "utf8"));
const SLOT = { fakespot: "classifierFakespot", tmr: "classifier", lite: "classifierLite", modernbert: "classifierModernBert" };
const r = (v, d = 3) => +Number(v).toFixed(d);

for (const dev of ["webgpu", "wasm"]) {
  const c = fit.constants[dev];
  const other = fit.constants[dev === "webgpu" ? "wasm" : "webgpu"];
  const get = (det) => c[det] ?? other[det];
  const cls = {};
  const unit = {};
  for (const [det, slot] of Object.entries(SLOT)) {
    const x = get(det);
    if (!x) continue;
    cls[slot] = { center: r(x.center), slope: r(x.slope) };
    unit[slot] = { center: r(x.unitCenter), slope: r(x.unitSlope) };
  }
  const ppl = get("perplexity");
  const bino = get("binoculars");
  const obj = {
    classifier: cls,
    perplexity: { tau: r(ppl.tau), a: r(ppl.slope), tauBurst: 0.58, b: 0 },
    binoculars: bino ? { tau: r(bino.tau), k: r(bino.slope) } : { tau: 0.82, k: 10 },
    ensemble: { wClassifier: 0.7, wPerplexity: 0.3 },
    fusionWeights: Object.fromEntries(Object.entries(fit.weights[dev]).map(([k, v]) => [k, r(v)])),
    unit: {
      classifier: unit,
      perplexityTau: r(ppl.unitTau),
      perplexityA: r(ppl.unitSlope),
      binocularsTau: bino ? r(bino.unitTau) : 0.82,
      binocularsK: bino ? r(bino.unitSlope) : 10,
    },
  };
  console.log(`// ${dev}\n` + JSON.stringify(obj, null, 2).replace(/"(\w+)":/g, "$1:") + "\n");
}
