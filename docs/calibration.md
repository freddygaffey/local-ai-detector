# Calibration (rough)

How the engine turns raw detector outputs into the 0..1 "AI likelihood" it
shows, and the small experiment the constants in
[`src/engine/calibration.ts`](../src/engine/calibration.ts) come from.

**Read the caveats first.** This is a sanity calibration on 49 short texts. It
is not a benchmark. The numbers below are much better than you should expect on
real web pages.

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

## The mappings (what ships)

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
