#!/usr/bin/env node
// Scores the transcript eval set (build-transcript-set.mjs) in Node (CPU,
// the WASM calibration constants) through the engine's own pipeline
// (src/engine/detect.ts), with the shipped chunker
// (src/content/youtube/chunk.ts) building the blocks, once per condition
// (cues.mjs). Writes, per item: the engine overall score, words analysed,
// and each block's mean sentence score and word count (segment-level stats).
//
//   node scripts/eval/transcripts/score-transcripts.mjs --set transcript-set.json \
//        --mode fusion|lite|tmr --conditions punct,raw,pause --out scores-fusion.json \
//        [--restored restored.json] [--cache <model cache dir>]
//   node scripts/eval/transcripts/score-transcripts.mjs --set transcript-set.json --dump-normalised norm.json

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CONDITIONS, conditionInput, normalisedWords } from "./cues.mjs";

await import("../../lib/ts-hooks.mjs");

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const setFile = opt("--set");
const items = JSON.parse(readFileSync(setFile, "utf8"));

const dump = opt("--dump-normalised");
if (dump) {
  writeFileSync(dump, JSON.stringify(Object.fromEntries(items.map((it) => [it.id, normalisedWords(it.timed).map((x) => x.w)]))));
  console.error(`wrote ${items.length} normalised texts to ${dump}`);
  process.exit(0);
}

const modeArg = opt("--mode", "fusion");
const conditions = (opt("--conditions", CONDITIONS.join(","))).split(",");
const out = opt("--out");
const restored = opt("--restored") ? JSON.parse(readFileSync(opt("--restored"), "utf8")) : null;

const { initRuntime } = await import("../../../src/engine/runtime.ts");
const { loadModel } = await import("../../../src/engine/loader.ts");
const { analyzeBlocks } = await import("../../../src/engine/detect.ts");
const { DEFAULT_MODELS } = await import("../../../src/engine/models.ts");
const { buildTranscriptBlocks, toTextBlocks } = await import("../../../src/content/youtube/chunk.ts");

await initRuntime({ cacheDir: opt("--cache") });
const load = (slot) => loadModel(slot, { repo: DEFAULT_MODELS[slot].repo, revision: DEFAULT_MODELS[slot].revision });
let mode;
let models;
if (modeArg === "lite") {
  mode = "classifierLite";
  models = { classifierLite: await load("classifierLite") };
} else if (modeArg === "tmr") {
  // The Quick tier's default: Fusion machinery with TMR alone (as the live auto-run sends it).
  mode = "ensemble";
  models = { classifier: await load("classifier") };
} else {
  mode = "ensemble";
  models = { classifierFakespot: await load("classifierFakespot"), classifier: await load("classifier") };
}
const fusion = { detectors: modeArg === "tmr" ? ["tmr"] : ["fakespot", "tmr"], method: "weighted" };

const prev = out && existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
const res = prev.scores ?? {};
const t0 = Date.now();
let n = 0;
for (const cond of conditions) {
  res[cond] ??= {};
  for (const it of items) {
    if (res[cond][it.id] !== undefined) continue;
    const input = conditionInput(it, cond, restored);
    if (!input) continue;
    const blocks = buildTranscriptBlocks(input.cues, { sentenceMode: input.sentenceMode });
    const { result } = await analyzeBlocks(toTextBlocks(blocks), { mode, minWords: 50, maxTokens: 4096, fusion }, models);
    const byBlock = new Map();
    for (const s of result.sentences) {
      const a = byBlock.get(s.blockId) ?? [];
      a.push(s.score);
      byBlock.set(s.blockId, a);
    }
    res[cond][it.id] = {
      overall: result.overall,
      words: result.words,
      device: result.device,
      blocks: blocks.map((b) => {
        const sc = byBlock.get(b.id) ?? [];
        return { words: b.words, score: sc.length ? sc.reduce((x, y) => x + y, 0) / sc.length : null };
      }),
    };
    if (++n % 50 === 0) {
      process.stderr.write(`${modeArg} ${cond}: ${n} (${((Date.now() - t0) / n).toFixed(0)} ms/text)\n`);
      if (out) writeFileSync(out, JSON.stringify({ mode: modeArg, scores: res }));
    }
  }
}
if (out) writeFileSync(out, JSON.stringify({ mode: modeArg, scores: res }));
console.error(`${modeArg}: done, ${n} new, ${n ? ((Date.now() - t0) / n).toFixed(0) : 0} ms/text`);
