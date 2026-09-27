#!/usr/bin/env node
// Builds the T7 web-genre evaluation set: modern LLM output and matched
// human text, weighted towards what people actually read on the web
// (forum posts and comments, reviews, news, how-to/blog articles, Q&A
// answers, stories, social posts), plus essays as a minor genre.
//
// Rows are fetched from the Hugging Face datasets-server API and cached
// under --cache (never committed; see docs/calibration.md for sources and
// licences). Our own AI-written samples (scripts/calibration/web-ai.json,
// MIT) are added as-is.
//
//   node scripts/eval/build-eval-set.mjs [--cache dir] [--n 40] [--seed 11] [--out eval.json]
//
// Output: [{id, set, source, licence, genre, label (1 = AI), generator, words, split, text}]
// `split` is "fit" or "test" (a hash of the text, so it is stable): constants
// are fitted on "fit" and every number in docs/calibration.md is on "test".

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const CACHE = resolve(opt("--cache", "node_modules/.cache/lad-eval"));
const N = Number(opt("--n", "40"));
const SEED = Number(opt("--seed", "11"));
const OUT = resolve(opt("--out", join(CACHE, "eval-set.json")));
const MIN_WORDS = Number(opt("--min-words", "30"));
const MAX_WORDS = 450;
mkdirSync(join(CACHE, "pages"), { recursive: true });

const words = (t) => t.split(/\s+/).filter(Boolean).length;
const sha = (s) => createHash("sha1").update(s).digest("hex");
function rng(s) {
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  const file = join(CACHE, "pages", sha(url) + ".json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    const j = res.ok ? await res.json().catch(() => null) : null;
    if (j && !j.error) {
      writeFileSync(file, JSON.stringify(j));
      return j;
    }
    if (attempt >= 8) throw new Error(`${res.status} ${j?.error ?? ""} for ${url}`);
    await sleep(5000 * (attempt + 1));
  }
}

/** Cuts a long text to <= MAX_WORDS at a sentence (or paragraph) boundary. */
const seg = new Intl.Segmenter("en", { granularity: "sentence" });
function trim(text) {
  text = text.replace(/\r\n/g, "\n").trim();
  if (words(text) <= MAX_WORDS) return text;
  let out = "";
  for (const s of seg.segment(text)) {
    if (words(out + s.segment) > MAX_WORDS) break;
    out += s.segment;
  }
  return out.trim();
}

// ---- Sources (all permissive; see docs/calibration.md "Eval set") ----
const HF = "https://datasets-server.huggingface.co";
const SOURCES = [];
const maga = (domain, genre) => {
  for (const label of [0, 1]) {
    SOURCES.push({
      set: "maga", licence: "MIT", genre, label, dataset: "anyangsong/MAGA", config: "MGB", split: "validation",
      pred: (r) => r.domain === domain && (r.model !== "human") === !!label,
      source: `MAGA MGB validation: ${domain}`, text: (r) => r.text, generator: (r) => r.model,
    });
  }
};
maga("Reddit", "forum");
maga("Yahoo Answers", "answer");
maga("Amazon Reviews", "review");
maga("Trustpilot Reviews", "review");
maga("CC News", "news");
maga("NPR News", "news");
maga("wikiHow", "blog");
const llmtrace = (type, genre) => {
  for (const label of [0, 1]) {
    SOURCES.push({
      set: "llmtrace", licence: "Apache-2.0", genre, label, dataset: "iitolstykh/LLMTrace_classification", config: "default",
      split: "test", pred: (r) => r.lang === "eng" && r.data_type === type && r.label === (label ? "ai" : "human"),
      source: `LLMTrace test: ${type}`, text: (r) => r.text, generator: (r) => r.model,
    });
  }
};
llmtrace("review", "review");
llmtrace("story", "story");
llmtrace("news", "news");
llmtrace("article", "blog");
llmtrace("question", "answer");
llmtrace("short_form", "social");
const dactyl = (domain, genre) => {
  for (const label of [0, 1]) {
    SOURCES.push({
      set: "dactyl", licence: "MIT", genre, label, dataset: "ShantanuT01/DACTYL", config: "default", split: "test",
      pred: (r) => r.domain === domain && Number(r.target) === label,
      source: `DACTYL test: ${domain}`, text: (r) => r.text, generator: (r) => r.model,
    });
  }
};
dactyl("reviews", "review");
dactyl("RedditWritingPrompts", "story");
dactyl("student_essays", "essay");
// 2026-generator AI answers/posts (the human halves are Reddit text these
// datasets don't redistribute, so only the AI side is used; the human side
// of these genres comes from MAGA Reddit / Yahoo Answers and MAGE).
SOURCES.push({
  set: "mild-rgb", licence: "CC-BY-4.0", genre: "answer", label: 1, dataset: "mild-rgb/eli5-human-vs-ai", config: "default",
  split: "test", jsonl: "https://huggingface.co/datasets/mild-rgb/eli5-human-vs-ai/resolve/main/test.jsonl",
  pred: (r) => r.label === "ai", source: "mild-rgb/eli5-human-vs-ai test (AI side)", text: (r) => r.text, generator: (r) => r.model,
});
SOURCES.push({
  set: "mild-rgb", licence: "Apache-2.0", genre: "forum", label: 1, dataset: "mild-rgb/aita-human-vs-ai", config: "default",
  split: "test", jsonl: "https://huggingface.co/datasets/mild-rgb/aita-human-vs-ai/resolve/main/test.jsonl",
  pred: (r) => r.label === "ai", source: "mild-rgb/aita-human-vs-ai test (AI side)", text: (r) => r.text, generator: (r) => r.generator,
});

/**
 * Samples every source of one dataset split together from random
 * datasets-server /rows pages (the /filter index is often still "loading"
 * for large datasets), keeping rows each source's predicate accepts.
 */
async function sampleSplit(srcs, rand) {
  const { dataset, config, split } = srcs[0];
  if (srcs[0].jsonl) return sampleJsonl(srcs, rand);
  const q = (offset, length) =>
    `${HF}/rows?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=${length}`;
  const total = (await getJSON(q(0, 1))).num_rows_total ?? 0;
  const want = srcs.map((s) => (s.set === "maga" && (s.genre === "review" || s.genre === "news") ? Math.ceil(N / 2) : N));
  const got = srcs.map(() => []);
  const seen = new Set();
  const maxPages = Number(opt("--max-pages", "400"));
  for (let page = 0; page < maxPages && got.some((g, i) => g.length < want[i]); page++) {
    const offset = Math.floor(rand() * Math.max(1, total - 100));
    const j = await getJSON(q(offset, 100));
    for (const { row } of j.rows ?? []) {
      const k = srcs.findIndex((s, i) => got[i].length < want[i] && s.pred(row));
      if (k < 0) continue;
      const src = srcs[k];
      const raw = src.text(row);
      if (typeof raw !== "string") continue;
      const text = trim(raw);
      const w = words(text);
      if (w < MIN_WORDS || seen.has(text) || rand() < 0.5) continue;
      seen.add(text);
      got[k].push({ set: src.set, source: src.source, licence: src.licence, genre: src.genre, label: src.label, generator: String(src.generator(row) ?? ""), words: w, text });
    }
  }
  srcs.forEach((s, i) => console.error(`${s.source} [${s.label ? "AI" : "human"}]: ${got[i].length}`));
  return got.flat();
}

/** Small datasets published as one JSONL file: read it whole (cached). */
async function sampleJsonl(srcs, rand) {
  const out = [];
  for (const src of srcs) {
    const file = join(CACHE, "pages", sha(src.jsonl) + ".jsonl");
    if (!existsSync(file)) {
      const res = await fetch(src.jsonl);
      if (!res.ok) throw new Error(`${res.status} for ${src.jsonl}`);
      writeFileSync(file, await res.text());
    }
    const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const got = [];
    for (const row of rows) {
      if (got.length >= N) break;
      if (!src.pred(row) || typeof src.text(row) !== "string") continue;
      const text = trim(src.text(row));
      if (words(text) < MIN_WORDS || rand() < 0.5) continue;
      got.push({ set: src.set, source: src.source, licence: src.licence, genre: src.genre, label: src.label, generator: String(src.generator(row) ?? ""), words: words(text), text });
    }
    console.error(`${src.source} [${src.label ? "AI" : "human"}]: ${got.length}`);
    out.push(...got);
  }
  return out;
}

const rand = rng(SEED);
const rows = [];
const groups = new Map();
for (const src of SOURCES) {
  const k = `${src.dataset}|${src.config}|${src.split}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(src);
}
for (const srcs of groups.values()) rows.push(...(await sampleSplit(srcs, rand)));

// Legacy MAGE sample (older generators), if cached by scripts/compare-classifiers.mjs.
for (const f of opt("--mage", "").split(",").filter(Boolean)) {
  for (const r of JSON.parse(readFileSync(f, "utf8"))) {
    const dom = r.source.replace(/^MAGE test: /, "");
    const genre = { cmv: "forum", eli5: "answer", yelp: "review", xsum: "news", tldr: "news", wp: "story", roct: "story" }[dom] ?? "other";
    rows.push({ set: "mage", source: r.source, licence: "Apache-2.0", genre, label: r.label, generator: "", words: words(r.text), text: r.text });
  }
}

// Our own AI-written samples (MIT, this repo).
const ownFile = new URL("../calibration/web-ai.json", import.meta.url);
const own = existsSync(ownFile) ? JSON.parse(readFileSync(ownFile, "utf8")) : [];
for (const r of own) rows.push({ set: "own", source: r.source, licence: "MIT (this repo)", genre: r.genre, label: 1, generator: r.generator ?? "Claude (this repo)", words: words(r.text), text: r.text });

const dedup = [...new Map(rows.map((r) => [r.text, r])).values()].map((r) => ({
  id: sha(r.text).slice(0, 12),
  ...r,
  split: parseInt(sha("split:" + r.text).slice(0, 8), 16) % 2 === 0 ? "fit" : "test",
}));
writeFileSync(OUT, JSON.stringify(dedup));
const by = {};
for (const r of dedup) {
  const k = `${r.genre}/${r.label ? "ai" : "human"}`;
  by[k] = (by[k] ?? 0) + 1;
}
console.error(`\n${dedup.length} texts -> ${OUT}`);
console.error(Object.entries(by).sort().map(([k, v]) => `${k}: ${v}`).join("\n"));
