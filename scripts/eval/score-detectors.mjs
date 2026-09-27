#!/usr/bin/env node
// Scores every text of the T7 eval set (scripts/eval/build-eval-set.mjs)
// with one candidate detector in Node (onnxruntime-node, CPU), through the
// engine's own pipeline (src/engine/detect.ts), and writes the raw
// statistic per text. Used to *rank* candidates by genre before the browser
// calibration of the chosen set (Node and browser differ slightly in
// absolute numbers but agree on ranking; docs/calibration.md).
//
//   node scripts/eval/score-detectors.mjs --detector tmr --eval eval-set.json --out scores-tmr.json [--cache dir]
//
// Detectors: tmr, lite, modernbert, fakespot, fakespot-fp32, gradient,
// perplexity, binoculars, or repo=<hf id>[@revision]:<file base>:<dtype>.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

await import("../lib/ts-hooks.mjs");
const { initRuntime } = await import("../../src/engine/runtime.ts");
const { loadModel } = await import("../../src/engine/loader.ts");
const { analyzeBlocks } = await import("../../src/engine/detect.ts");
const { DEFAULT_MODELS } = await import("../../src/engine/models.ts");

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const detector = opt("--detector");
const evalFile = opt("--eval");
const out = opt("--out");
const cacheDir = opt("--cache");
const limit = Number(opt("--limit", "0"));

/** Candidate classifiers not (yet) in the registry: {repo, revision, file, dtype}. */
const CANDIDATES = {
  fakespot: { repo: "amankrai28/fakespot-roberta-ai-detector-onnx", revision: "main", file: "model", dtype: "q8" },
  "fakespot-fp32": { repo: "Lynote/fakespot-ai-roberta-base-ai-text-detection-v1-browser", revision: "main", file: "model", dtype: "fp32" },
  gradient: { repo: "batmac/gradient-ai-text-detector-onnx", revision: "main", file: "model", dtype: "q4" },
};

await initRuntime({ cacheDir });
let mode;
let models;
if (["tmr", "lite", "modernbert"].includes(detector) || DEFAULT_MODELS[detector]) {
  const slot = { tmr: "classifier", lite: "classifierLite", modernbert: "classifierModernBert" }[detector] ?? detector;
  const spec = DEFAULT_MODELS[slot];
  mode = "classifier";
  // Run the slot's model through the "classifier" slot machinery.
  const m = await loadModel(slot, { repo: spec.repo, revision: spec.revision });
  models = { classifier: m };
} else if (detector === "perplexity") {
  mode = "perplexity";
  const s = DEFAULT_MODELS.perplexityLM;
  models = { perplexityLM: await loadModel("perplexityLM", { repo: s.repo, revision: s.revision }) };
} else if (detector === "binoculars") {
  mode = "binoculars";
  const o = DEFAULT_MODELS.binocularsObserver;
  const p = DEFAULT_MODELS.binocularsPerformer;
  models = {
    binocularsObserver: await loadModel("binocularsObserver", { repo: o.repo, revision: o.revision }),
    binocularsPerformer: await loadModel("binocularsPerformer", { repo: p.repo, revision: p.revision }),
  };
} else {
  let c = CANDIDATES[detector];
  if (!c && detector?.startsWith("local=")) {
    // A local conversion (optimum export): <dir>/{config.json,tokenizer.json,onnx/model_quantized.onnx}
    const { env } = await import("@huggingface/transformers");
    const { dirname, basename } = await import("node:path");
    const dir = detector.slice(6);
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = dirname(dir) + "/";
    c = { repo: basename(dir), revision: "main", file: "model", dtype: "q8" };
  }
  if (!c && detector?.startsWith("repo=")) {
    const [repoRev, file, dtype] = detector.slice(5).split(":");
    const [repo, revision = "main"] = repoRev.split("@");
    c = { repo, revision, file: file || "model", dtype: dtype || "q8" };
  }
  if (!c) throw new Error(`unknown detector ${detector}`);
  // Borrow the classifier slot with this candidate's file/dtype.
  DEFAULT_MODELS.classifier = { ...DEFAULT_MODELS.classifier, repo: c.repo, revision: c.revision, modelFileName: c.file, dtypes: { wasm: c.dtype, webgpuF16: c.dtype } };
  mode = "classifier";
  models = { classifier: await loadModel("classifier", { repo: c.repo, revision: c.revision }) };
}

const seg = new Intl.Segmenter("en", { granularity: "sentence" });
function toBlocks(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((para, i) => {
      const sentences = [];
      for (const s of seg.segment(para)) {
        const t = s.segment.replace(/\s+$/, "");
        if (t.trim()) sentences.push({ start: s.index, end: s.index + t.length });
      }
      return { id: `p${i}`, text: para, sentences };
    });
}

let items = JSON.parse(readFileSync(evalFile, "utf8"));
if (limit) items = items.slice(0, limit);
const prev = out && existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
const res = prev.scores ?? {};
const t0 = Date.now();
let n = 0;
for (const it of items) {
  if (res[it.id] !== undefined) continue;
  const { stats } = await analyzeBlocks(toBlocks(it.text), { mode, minWords: 50, maxTokens: 4096 }, models);
  res[it.id] =
    mode === "classifier" ? stats.classifierRaw : mode === "perplexity" ? stats.logPPL : stats.binoculars;
  if (++n % 50 === 0) {
    process.stderr.write(`${detector}: ${n} (${((Date.now() - t0) / n).toFixed(0)} ms/text)\n`);
    if (out) writeFileSync(out, JSON.stringify({ detector, scores: res }));
  }
}
const msPerText = n ? (Date.now() - t0) / n : null;
if (out) writeFileSync(out, JSON.stringify({ detector, msPerText, scores: res }));
console.error(`${detector}: done, ${n} new texts, ${msPerText?.toFixed(0)} ms/text`);
