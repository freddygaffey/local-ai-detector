# Calibration (rough)

How the engine turns raw detector outputs into the 0..1 "AI likelihood" it
shows, and the small experiment the constants in
[`src/engine/calibration.ts`](../src/engine/calibration.ts) come from.

**Read the caveats first.** This is a sanity calibration on small samples. It
is not a benchmark. Expect real web pages to go worse than the numbers below.

## What ships (T5, 2026-09-27)

The constants in `calibration.ts` were **re-fitted on the extension itself**
running in Chrome, not on Node. The first calibration (below, "First
calibration (Node)") turned out not to transfer to the browser:

- **Browser vs Node.** The same q8 model files on the same text blocks give
  different outputs in ONNX Runtime Web (WASM) and in onnxruntime-node. On one
  fixture page the lite classifier's mapped score was 0.59 in the browser and
  0.27 in Node; perplexity moved by 0.03–0.05. TMR was closest (0.52 against 0.48).
- **WASM vs WebGPU.** WebGPU runs different weights (q4f16 / fp16), and its
  outputs differ more. On a human-written page, TMR scored 0.33 on WebGPU and
  0.52 on WASM; lite scored 0.15 and 0.59.
  The Binoculars pair on WebGPU (q4f16) produced uniform logits, so every unit
  scored exactly 1.0. Binoculars now always runs on WASM q8.
- **Firefox = Chrome WASM.** Firefox runs WASM (one thread). Its scores
  matched Chrome's WASM scores to three decimals on the fixture pages (for
  example news page: classifier 0.543, perplexity 0.476 in both).

So **WASM is the default device** (`settings.useWebGPU = false`), which gives the
same scores in both browsers and uses one set of constants. WebGPU is an
opt-in in Options with its own constants (`WEBGPU_CALIBRATION`), fitted the
same way. `calibrationFor(model.device)` picks between them per model.

### Data and method

- `scripts/e2e/browser-calibration.mjs` loads the e2e build in Chrome for
  Testing 153 and sends every text as `analyze` blocks, for classifier,
  classifier-lite and perplexity, on WASM and on WebGPU. It recovers the raw statistic by
  inverting the mapping that shipped at the time, then fits the new one.
- Texts: the 49 calibration texts (below), plus **595 held-out texts from MAGE**
  (`yaful/MAGE` test split, Apache-2.0). They are fetched and cached by
  `scripts/compare-classifiers.mjs` and are never committed. The sample is 120–450 words, two seeds,
  and de-duplicated. It covers 10+ domains (sci_gen, xsum, cmv, wp, eli5, yelp, tldr, …) and many
  generators (GPT-3.5, text-davinci-002/003, OPT, LLaMA 65B, GLM-130B,
  GPT-4 paraphrases, …). Neither classifier was trained on MAGE.
- **Operating point.** Each detector's 0.5 sits where about 5% of the pooled human
  texts score higher. That is a deliberately low false-positive point: a detector
  that wrongly accuses people does more harm than one that misses some AI
  text. **The whole UI uses this scale.** A sentence at or above 0.5 is "flagged",
  and a page at or above 0.5 gets "Likely AI-generated patterns". Below 0.35 is
  "likely human", and 0.35–0.5 is "mixed" (`src/shared/thresholds.ts`). So 50% on
  the gauge means "scored higher than about 95% of the human texts we tested", not
  "a 50% chance it's AI".
- **Slopes.** We kept T1's slopes. A logistic fit on the pooled data gave
  about half of them (TMR 0.51). That squeezed almost every ensemble score
  into 0.3–0.6, where the bands can't tell texts apart.

| Constant (WASM, default) | Before (Node fit) | Now |
|---|---|---|
| TMR center / slope (logit) | 3.96 / 1.27 | **3.84** / 1.27 |
| Lite center / slope | 0.76 / 1.72 | **2.70** / 1.72 |
| Perplexity τ / a | 3.5 / 2.0 | **3.17** / 2.0 |
| Binoculars τ / k | 0.82 / 10 | 0.82 / 10 (unchanged, experimental) |
| Ensemble weights | 0.7 / 0.3 | 0.7 / 0.3 |

WebGPU: TMR center 3.14, lite 1.91, perplexity τ 2.93 (same slopes).

### Results in the browser (WASM, shipping constants)

| Detector | Calibration set (28 human / 21 AI): AUROC · FPR · TPR | MAGE held-out (295 human / 300 AI): AUROC · FPR · TPR |
|---|---|---|
| Classifier (TMR) | 1.00 · 0.36 · 1.00 | 0.91 · 0.02 · 0.68 |
| Classifier-lite | 0.97 · 0.00 · 0.43 | 0.84 · 0.06 · 0.37 |
| Perplexity | 0.87 · 0.04 · 0.19 | 0.69 · 0.05 · 0.26 |
| **Ensemble (TMR + perplexity), default** | 0.97 · 0.11 · 0.95 | **0.92 · 0.01 · 0.46** |
| Ensemble (lite + perplexity) | 0.96 · 0.00 · 0.33 | 0.83 · 0.03 · 0.27 |

FPR and TPR are at the 0.5 threshold. The MAGE rows were used to place the thresholds, so
they are not a clean held-out test of the *threshold*. They are still a held-out test of the
*ranking* (AUROC), which the mapping cannot change.

What this means in practice: at the default settings the ensemble rarely flags MAGE's
human texts (3 of 295). It flags 3 of the 28 calibration human texts, all of them modern
US-government prose. It **misses about half of the AI text** (it flags 46% of MAGE's AI texts). TMR on its own flags 10 of the
28 calibration human texts, mostly the modern US-government prose. That is the hard case
for every detector here.

## Which classifier the ensemble uses

**TMR (`onnx-community/tmr-ai-text-detector-ONNX`), not the lite model.** T1's
49-text sample favoured lite, but that sample is small, in-sample and single-generator. On
held-out data the picture is reversed:

| | TMR | Lite |
|---|---|---|
| MAGE AUROC, Node q8 (seed 7 / seed 23, 300 texts each) | **0.90 / 0.93** | 0.86 / 0.84 |
| MAGE AUROC, browser WASM (595 texts) | **0.91** | 0.84 |
| MAGE AUROC, browser WebGPU | **0.90** | 0.86 |
| MAGE human texts flagged at the raw 0.5 (Node, seed 23) | 29% | 48% |
| Ensemble AUROC, browser WASM | **0.91** | 0.84 |
| Download (q8) | 126 MB | 34 MB |
| Warm analysis of a ~500-word page (Chrome WASM, 4 threads) | ~0.1–1.9 s | ~0.05–0.6 s |

On MAGE, TMR ranks texts better across domains. In seed 23, XSum news gave TMR 0.96
against lite 0.81, and CMV forum posts 0.91 against 0.77. The lite model's scores for human
text also spread much more widely. Lite stays available: **Options → Ensemble classifier**
(`settings.ensembleClassifier`), and "Classifier-lite" is still its own mode.
Reproduce the comparison with `node scripts/compare-classifiers.mjs` (Node) and
`node scripts/e2e/browser-calibration.mjs` (browser).

The fixture pages in `scripts/e2e/fixtures/` were also scored, but they reuse
calibration texts, so they are in-sample. Overall scores, Chrome WebGPU,
before the re-calibration:
blog (human + 2 AI comments) TMR 0.46 / lite 0.18; SPA AI article TMR 0.58 / lite 0.91;
SPA human article TMR 0.33 / lite 0.15. See [qa.md](qa.md).

---

## First calibration (Node, T1), kept for reference

## How to reproduce

```sh
node scripts/calibrate.mjs --cache /some/dir --out results.json
```

The script runs the real engine code (`src/engine/*.ts`, through Node's type
stripping) on CPU with the pinned default models. The first run downloads about
600 MB. Add `--skip-binoculars` to skip the two SmolLM2 models. A full run takes
about 30 s on an Apple M-series laptop once the models are cached. The script
prints raw statistics and fitted parameters. Those were then copied into
`calibration.ts` by hand, with some rounding and judgement (see below).

## Data

| Set | n | Source | Licence |
|---|---|---|---|
| Human, literary | 19 | ~150–270-word excerpts from the middle of Project Gutenberg books (Austen, Twain, Dickens, Shelley, Melville, Darwin, Kafka, Emerson, …); one per book | Public domain (US) |
| Human, modern expository | 9 | Paragraphs from US federal agency web pages (NPS, NWS, USGS, Library of Congress, CDC), taken from **2019** Wayback Machine snapshots so they predate LLM writing tools | Public domain (17 U.S.C. §105) |
| AI | 21 | ~140–200-word texts written for this repo by an LLM (Claude) across 21 genres: essay, product copy, cover letter, email, story, period-style narrative, casual anecdote, forum answer, news, speech, … | MIT (this repo) |

Files: [`scripts/calibration/human.json`](../scripts/calibration/human.json) and
[`scripts/calibration/ai.json`](../scripts/calibration/ai.json). Each entry records its source.
No copyrighted text is included.

Each text is split into paragraphs (blocks) and sentences with
`Intl.Segmenter`, then analysed exactly as a page would be (`minWords` 50,
`maxTokens` 4096). The statistics are per text (document level).

## Results (2026-09-27, CPU, q8 weights)

AUROC is the probability that a random AI text scores higher than a random
human text (1.0 means perfect ranking and 0.5 means chance). Accuracy is measured at a 0.5
threshold on the mapped probability.

| Detector | Raw signal | AUROC | Accuracy @0.5 (raw) | Accuracy @0.5 (after mapping) |
|---|---|---|---|---|
| Classifier (TMR RoBERTa, `classifier`) | P(ai) | 1.00* | 0.59 (20 of 28 human texts flagged) | 0.90 |
| Classifier-lite (e5-small, `classifierLite`) | P(LABEL_1) | 0.98 | 0.94 | 0.98 |
| Perplexity (DistilGPT-2) | −log-PPL | 0.88 | – | 0.84 (leave-one-out: 0.80) |
| Burstiness (std of sentence log-PPL) | −burstiness | 0.51 | – | – (not used) |
| Binoculars (SmolLM2-135M pair, experimental) | −score | 0.99 | – | 0.94 |
| **Ensemble** (0.7 × classifier + 0.3 × perplexity) | – | 0.97 | – | 0.88 |

\* The TMR AUROC of 1.00 is misleading. The model is saturated: every AI text
scored 0.985–0.988, and the modern human texts scored 0.972–0.985. The ranking
holds only in the third decimal place. With the raw 0.5 threshold it flags
**every** modern human text and half the literary ones. That is why it gets the
logit-space re-centring below. Expect it to behave differently (and probably
worse) on other writers and other LLMs.

Mean statistics:

| | Human (literary) | Human (modern) | AI |
|---|---|---|---|
| log-PPL (DistilGPT-2) | 4.17 | 3.55 | 3.31 |
| Binoculars score | 0.95 | 0.92 | 0.72 |

Modern expository human prose is much more predictable than the 19th-century
excerpts and sits close to the AI texts. That is the known weakness of
perplexity detectors, and it is why the ensemble leans on the classifier.

## The mappings (T1 values, since replaced; see "What ships")

All logs are natural logs. `logit(p) = ln(p / (1 − p))`.

- **Classifier** (default repos only; a custom model keeps its own scale):
  `p' = sigmoid(slope · (logit(p) − center))`
  - TMR: center **3.96** (raw p ≈ 0.981), slope **1.27**
  - Lite: center **0.76**, slope **1.72**

  The fit is a 1-D logistic regression on logit(p), lightly regularised, with
  the slope capped at 2 so a tiny, near-separable sample can't produce a
  knife-edge threshold. Neither fit hit the cap.
- **Perplexity**:
  `p = sigmoid(a · (τ − logPPL) + b · (τ_b − burstiness))`
  with **τ = 3.5, a = 2.0, τ_b = 0.58, b = 0**. The fit is a logistic
  regression on (logPPL, burstiness). Burstiness carried no signal (AUROC 0.51),
  so `b` is 0 and it is effectively unused. The term stays in the code for
  future calibration. Per-sentence colours use the log-PPL of each group of
  ≥ `minWords` words.
- **Binoculars** (experimental): score = performer log-PPL ÷
  observer/performer cross-entropy (lower means more AI-like), and
  `p = sigmoid(k · (τ − score))` with **τ = 0.82, k = 10**.
- **Ensemble**: `p = (w_C · p_classifier + w_P · p_perplexity) / (w_C + w_P)`
  with **w_C = 0.7, w_P = 0.3**, averaged in probability space per sentence and
  for the overall score. It can never be more extreme than its most extreme
  input. On this sample the ranking kept improving as classifier weight went up
  (AUROC 0.88 at w_C = 0, 0.97 at 0.7, 1.00 at 1.0). We stopped at 0.7 on
  purpose: the classifier result is the most likely to be an artefact of this
  sample (see the saturation note above), and the perplexity signal is at least
  model-independent.

## Caveats (please keep these in the UI and README)

- **Tiny, biased sample.** There are 49 texts. All the AI texts come from one
  model family (Claude), written in one sitting. Other LLMs, sampling
  temperatures, prompts that ask for a human style, and paraphrasing tools are
  not represented. Real-world accuracy will be lower, possibly much lower
  ([RAID](https://arxiv.org/abs/2405.07940) shows paraphrasing defeats most
  detectors).
- **The parameters were fitted on the same data they are evaluated on.**
  Leave-one-out accuracy for the perplexity fit is 0.80 against 0.84 in-sample.
  The other numbers have no held-out check.
- **The human side is easy mode.** Most of it is 19th-century literature, which
  no modern LLM writes like. The nine modern government texts are harder, and
  they are where the false positives came from.
- **Short texts are noisy.** Each text here is 143–269 words. Single sentences
  and anything under `minWords` (default 50) are folded into their neighbours.
  Treat per-sentence colours as a relative heat-map, not a verdict.
- **Known bias:** perplexity-style detectors flag non-native English writers at
  high rates (Liang et al., 2023). Everything here is English-only.
- **Device and dtype matter slightly.** Calibration used CPU q8. WebGPU uses
  q4f16/fp16 weights. A spot check of TMR q8, fp32 and q4f16 on 24 texts moved
  P(ai) by at most ~0.04, but the perplexity and Binoculars statistics were not
  re-checked on fp16.
- If you change a default model or revision (for example through "Update
  model"), these constants are no longer calibrated for it. The classifier
  re-centring only applies to the pinned default repo. An updated revision of
  that same repo still gets it, which is probably right for small fine-tune
  refreshes and wrong for a retrained model.
