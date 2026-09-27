#!/usr/bin/env node
// Builds the T10 transcript eval set (docs/calibration.md "Transcripts"):
// AI-written video scripts against human speech and human-written prose,
// every text given word-level timing so it can be turned into YouTube-style
// caption cues (make-cues.mjs).
//
//   node scripts/eval/transcripts/build-transcript-set.mjs --cache <dir> \
//        --eval <T7 eval-set.json> --out transcript-set.json
//
// Sources (rows fetched from the Hugging Face datasets-server API and cached
// in --cache; not committed):
//   human speech  MLCommons/peoples_speech "clean" test (CC-BY-4.0): archive.org talks,
//                 lectures, hearings; lowercase, unpunctuated, 1-15 s segments with durations.
//                 distil-whisper/earnings22 "chunked" test (CC-BY-SA-4.0): earnings calls,
//                 punctuated, contiguous segments with start/end times.
//   human prose   The T7 web eval set's human news / blog / story / answer texts (MAGA MIT,
//                 LLMTrace Apache-2.0, DACTYL MIT): stands in for human-written scripts read aloud.
//   AI            scripts/calibration/transcript-ai.json (MIT, this repo; Claude, voiceover
//                 scripts) and the T7 eval set's AI news / blog / story / answer texts.
// Texts are 120-420 words. The fit / test split is by a hash of the id
// (T7 texts keep their own split).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const cache = opt("--cache", ".transcript-cache");
const evalFile = opt("--eval");
const out = opt("--out", "transcript-set.json");
const perGenre = Number(opt("--per-genre", "30"));
mkdirSync(cache, { recursive: true });

const hash = (s) => createHash("sha1").update(s).digest("hex");
const splitOf = (id) => (parseInt(hash(id).slice(0, 8), 16) % 2 === 0 ? "fit" : "test");
const words = (t) => t.trim().split(/\s+/).filter(Boolean);

async function rows(dataset, config, split, offset, length) {
  const f = join(cache, `${dataset.replace("/", "__")}-${config}-${split}-${offset}-${length}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=${length}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const j = await res.json();
      const r = j.rows.map((x) => {
        const { audio, ...rest } = x.row;
        return rest;
      });
      writeFileSync(f, JSON.stringify(r));
      return r;
    }
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  throw new Error(`fetch failed: ${url}`);
}

/** Word timings for a text read at a steady pace, pausing at punctuation (TTS-like). */
function readAloudTiming(text, seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = [];
  let t = 0.5;
  for (const w of words(text)) {
    out.push({ w, t: Number(t.toFixed(2)) });
    t += (0.3 + 0.18 * rnd()) * Math.max(0.6, Math.min(2, w.length / 5));
    if (/[.?!]["')]?$/.test(w)) t += 0.35 + 0.5 * rnd();
    else if (/[,;:]$/.test(w)) t += 0.12 + 0.2 * rnd();
  }
  return out;
}

/** Word timings spread evenly across each timed segment (real speech: gaps between segments are real pauses). */
function segmentTiming(segments) {
  const out = [];
  for (const seg of segments) {
    const ws = words(seg.text);
    const dur = Math.max(0.3, seg.end - seg.start);
    ws.forEach((w, i) => out.push({ w, t: Number((seg.start + (dur * i) / ws.length).toFixed(2)) }));
  }
  return out;
}

function capWords(timed, max) {
  if (timed.length <= max) return timed;
  // Cut at the last sentence end before `max`, if there is one.
  let cut = max;
  for (let i = max; i > max * 0.6; i--) {
    if (/[.?!]$/.test(timed[i - 1].w)) {
      cut = i;
      break;
    }
  }
  return timed.slice(0, cut);
}

const items = [];

// ---- Human speech: People's Speech (clean, test) ----
{
  const bySource = new Map();
  for (let off = 0; off < 34800; off += 300) {
    let batch = [];
    try {
      batch = await rows("MLCommons/peoples_speech", "clean", "test", off, 100);
    } catch {
      continue; // rate-limited; the next run picks it up from the cache
    }
    for (const r of batch) {
      const src = r.id.split("/")[0];
      const m = r.id.match(/_(\d+)\.flac$/);
      const idx = m ? Number(m[1]) : 0;
      if (!bySource.has(src)) bySource.set(src, []);
      bySource.get(src).push({ idx, text: r.text, dur: r.duration_ms / 1000 });
    }
  }
  // Segments per source are a sample of the recording, in order. Lay them
  // end to end with a natural pause between them.
  for (const [src, segs] of bySource) {
    segs.sort((a, b) => a.idx - b.idx);
    let t = 0;
    const timed = [];
    for (const s of segs) {
      timed.push({ start: t, end: t + s.dur, text: s.text });
      t += s.dur + 0.6;
    }
    const tw = capWords(segmentTiming(timed), 400);
    if (tw.length < 120) continue;
    const id = `ps-${hash(src).slice(0, 10)}`;
    items.push({ id, label: 0, group: "speech", genre: "speech", source: `People's Speech (clean, test): ${src}`, licence: "CC-BY-4.0", punctuated: false, split: splitOf(id), timed: tw });
  }
}

// ---- Human speech: Earnings-22 (chunked, test) ----
// 57k segments over 125 calls. One passage per 100-row window, windows spread
// across the split, so passages come from many different calls.
{
  for (let off = 0; off < 57300; off += 900) {
    let r;
    try {
      r = await rows("distil-whisper/earnings22", "chunked", "test", off, 100);
    } catch {
      continue;
    }
    const byFile = new Map();
    for (const x of r) {
      if (!byFile.has(x.file_id)) byFile.set(x.file_id, []);
      byFile.get(x.file_id).push({ seg: Number(x.segment_id), start: x.start_ts, end: x.end_ts, text: x.transcription });
    }
    // The file with the most rows in this window.
    const [file, segs] = [...byFile].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    if (!segs) continue;
    segs.sort((a, b) => a.seg - b.seg);
    const tw = capWords(segmentTiming(segs.filter((s) => s.text && s.text.trim())), 380);
    if (tw.length < 150) continue;
    const t0 = tw[0].t;
    const id = `e22-${file}-${off}`;
    items.push({ id, label: 0, group: "speech", genre: "speech", source: `Earnings-22 (test): call ${file}`, licence: "CC-BY-SA-4.0", punctuated: true, split: splitOf(id), timed: tw.map((x) => ({ w: x.w, t: Number((x.t - t0 + 0.5).toFixed(2)) })) });
  }
}

// ---- T7 web eval set: human prose (scripted proxy) and AI text ----
if (evalFile) {
  const evalSet = JSON.parse(readFileSync(evalFile, "utf8"));
  const genres = ["news", "blog", "story", "answer"];
  const pick = (label, genre) =>
    evalSet
      .filter((x) => Number(x.label) === label && x.genre === genre && x.set !== "mage" && !String(x.id).startsWith("own-") && words(x.text).length >= 120)
      .sort((a, b) => (hash(a.id) < hash(b.id) ? -1 : 1))
      .slice(0, perGenre);
  for (const label of [0, 1]) {
    for (const g of genres) {
      for (const x of pick(label, g)) {
        const text = x.text.replace(/\s+/g, " ");
        items.push({
          id: `t7-${x.id}`,
          label,
          group: label ? "ai-web" : "human-prose",
          genre: g,
          source: x.source,
          licence: x.licence,
          punctuated: true,
          split: x.split === "fit" ? "fit" : "test",
          timed: capWords(readAloudTiming(text, parseInt(hash(x.id).slice(0, 8), 16)), 420),
        });
      }
    }
  }
}

// ---- Our own AI voiceover scripts ----
{
  const own = JSON.parse(readFileSync(new URL("../../calibration/transcript-ai.json", import.meta.url), "utf8"));
  for (const x of own) {
    const text = x.text.replace(/\s+/g, " ");
    items.push({ id: x.id, label: 1, group: "ai-script", genre: "script", source: `Written for this repo by an LLM (Claude). Prompt: ${x.prompt}`, licence: "MIT", punctuated: true, split: splitOf(x.id), timed: capWords(readAloudTiming(text, parseInt(hash(x.id).slice(0, 8), 16)), 420) });
  }
}

const summary = {};
for (const it of items) {
  const k = `${it.group}|${it.split}`;
  summary[k] = (summary[k] ?? 0) + 1;
}
console.error(summary);
writeFileSync(out, JSON.stringify(items));
console.error(`wrote ${items.length} items to ${out}`);
