# Calibration

How the engine turns raw detector outputs into its 0..1 score, how that score
becomes the probability the UI shows ("AI 91%"), and the experiments the
constants in [`src/engine/calibration.ts`](../src/engine/calibration.ts) and
[`src/shared/displayCalibration.ts`](../src/shared/displayCalibration.ts) come from.

**Read the caveats first.** These are measurements on one eval set of about
1,900 web texts. It is not a general benchmark. Unseen generators, prompts
that ask for a human style, and paraphrasing all do worse.

## What ships (T7, 2026-09-27)

Two scales:

- **Engine score** (`AnalyzeResult.overall`, sentence `score`): 0.5 is where 5% of human
  texts score higher (the "flagged" point; `FLAGGED_THRESHOLD`), and 0.75 is where 1% do
  (the slop filter; `FILTER_THRESHOLD`). The bands in `src/shared/thresholds.ts` use this scale.
- **Display probability** (`AnalyzeResult.probability`, `toDisplayProbability()`): the
  calibrated P(AI) for the detector set, device and text length that produced the score,
  fitted on held-out web text with a 50/50 mix. Undefined below `MIN_WORDS_FOR_SCORE` (30) words.

Defaults:

| | Choice | Why |
|---|---|---|
| Fusion (click / full run) | **Fakespot + TMR, weighted average** (weights 1 : 0.12) | Fakespot is the best single detector on every genre but forum posts. Adding TMR keeps AUROC (0.91) and improves slop-filter precision (99–100% against 98%) and display calibration (ECE 0.040 against 0.045), and the second detector gives the UI an agreement signal. No other set beat it by 0.01 on the fit half. |
| Auto-run pass | **Lite (e5-small)**, unchanged | Smallest and fastest (200 ms per 1,000 words on WebGPU). It is much weaker (AUROC 0.77), so it rarely reaches the filter threshold: precision 97%, recall 22%. TMR would rank better (0.87) and is already downloaded for Fusion, but its score scale is capped (see "Slopes"), so it barely reaches 0.75. |
| Device | **WebGPU on by default**, WASM fallback | TMR and lite run fp16 on WebGPU. q4f16 ranked worse (TMR AUROC 0.844 against 0.861, lite 0.735 against 0.756) at the same speed. Perplexity runs fp16. Fakespot (q8-only repo; int8 has no WebGPU kernels, so it was slower and ranked worse there: 0.907 against 0.932), ModernBERT (fp16 and q4f16 give one constant output on WebGPU; fp32 works but is a 599 MB download) and Binoculars (q4f16 and fp16 are both constant) always run on WASM. A default Fusion run is therefore `device: "mixed"`. |

### Results (test half)

AUROC per genre, then over all web genres: human texts flagged (FPR) and AI texts flagged
(TPR) at score ≥ 0.5, slop-filter precision and recall at ≥ 0.75, and the display
probability's expected calibration error (ECE, 10 bins). "short" means under 150 words. Emails
are six AI-only samples, so that column shows the detection rate. Test half: about 900 texts, so
each genre cell has roughly 50–100 texts and an AUROC uncertainty of about ±0.04–0.06.

#### WebGPU path (primary)


| Detector set | forum | answer | review | news | blog | social | story | essay | email | short | long | **all** | flag FPR / TPR | filter precision / recall | ECE |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fakespot | 0.84 | 0.87 | 0.98 | 0.92 | 0.89 | 0.93 | 0.94 | 0.93 | TPR 0% | 0.91 | 0.92 | **0.91** | 5% / 68% | 98% / 57% | 0.045 |
| tmr | 0.72 | 0.89 | 0.92 | 0.90 | 0.91 | 0.95 | 0.88 | 0.90 | TPR 100% | 0.88 | 0.85 | **0.87** | 4% / 58% | 100% / 5% | 0.047 |
| lite | 0.65 | 0.74 | 0.82 | 0.78 | 0.76 | 0.88 | 0.80 | 0.90 | TPR 100% | 0.77 | 0.79 | **0.77** | 6% / 39% | 97% / 22% | 0.071 |
| modernbert | 0.60 | 0.76 | 0.85 | 0.70 | 0.69 | 0.77 | 0.68 | 0.74 | TPR 100% | 0.79 | 0.66 | **0.72** | 4% / 8% | 67% / 1% | 0.039 |
| perplexity | 0.79 | 0.66 | 0.83 | 0.68 | 0.69 | 0.83 | 0.75 | 0.92 | TPR 0% | 0.74 | 0.71 | **0.73** | 3% / 17% | 0% / 0% | 0.079 |
| binoculars | 0.80 | 0.69 | 0.86 | 0.79 | 0.75 | 0.80 | 0.86 | 0.97 | TPR 100% | 0.76 | 0.81 | **0.79** | 5% / 51% | 100% / 2% | 0.061 |
| **Default Fusion** (fakespot + tmr, weighted) | 0.81 | 0.87 | 0.98 | 0.92 | 0.90 | 0.94 | 0.94 | 0.93 | TPR 0% | 0.91 | 0.91 | **0.91** | 5% / 68% | 99% / 54% | 0.040 |
| Default set, logodds | 0.77 | 0.91 | 0.96 | 0.93 | 0.93 | 0.96 | 0.92 | 0.92 | TPR 0% | 0.91 | 0.90 | **0.90** | 2% / 64% | 100% / 43% | 0.043 |
| Default set, vote | 0.79 | 0.90 | 0.94 | 0.94 | 0.93 | 0.95 | 0.91 | 0.91 | TPR 0% | 0.90 | 0.89 | **0.90** | 0% / 54% | 100% / 5% | 0.048 |
| Default set, max | 0.77 | 0.87 | 0.98 | 0.90 | 0.89 | 0.95 | 0.93 | 0.93 | TPR 100% | 0.91 | 0.89 | **0.90** | 9% / 73% | 98% / 57% | 0.052 |
| Classic (tmr + perplexity) | 0.76 | 0.85 | 0.90 | 0.88 | 0.90 | 0.92 | 0.88 | 0.92 | TPR 100% | 0.87 | 0.84 | **0.86** | 2% / 49% | – / 0% | 0.045 |
| Fast (lite + perplexity) | 0.74 | 0.72 | 0.83 | 0.76 | 0.76 | 0.90 | 0.84 | 0.92 | TPR 0% | 0.78 | 0.78 | **0.78** | 2% / 32% | 100% / 1% | 0.072 |

#### WASM path (fallback)


| Detector set | forum | answer | review | news | blog | social | story | essay | email | short | long | **all** | flag FPR / TPR | filter precision / recall | ECE |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fakespot | 0.84 | 0.87 | 0.98 | 0.92 | 0.89 | 0.93 | 0.94 | 0.93 | TPR 0% | 0.91 | 0.92 | **0.91** | 5% / 68% | 98% / 57% | 0.045 |
| tmr | 0.72 | 0.89 | 0.92 | 0.89 | 0.90 | 0.94 | 0.88 | 0.90 | TPR 100% | 0.88 | 0.85 | **0.87** | 3% / 57% | 100% / 0% | 0.041 |
| lite | 0.66 | 0.76 | 0.83 | 0.78 | 0.74 | 0.88 | 0.80 | 0.89 | TPR 100% | 0.77 | 0.79 | **0.77** | 6% / 37% | 97% / 18% | 0.063 |
| modernbert | 0.60 | 0.76 | 0.85 | 0.70 | 0.69 | 0.77 | 0.68 | 0.74 | TPR 100% | 0.79 | 0.66 | **0.72** | 4% / 8% | 67% / 1% | 0.039 |
| perplexity | 0.77 | 0.65 | 0.81 | 0.67 | 0.67 | 0.81 | 0.74 | 0.91 | TPR 0% | 0.73 | 0.69 | **0.72** | 3% / 13% | 0% / 0% | 0.083 |
| binoculars | 0.80 | 0.69 | 0.86 | 0.79 | 0.75 | 0.80 | 0.86 | 0.97 | TPR 100% | 0.76 | 0.81 | **0.79** | 5% / 51% | 100% / 2% | 0.061 |
| **Default Fusion** (fakespot + tmr, weighted) | 0.81 | 0.87 | 0.98 | 0.92 | 0.90 | 0.94 | 0.94 | 0.93 | TPR 0% | 0.91 | 0.91 | **0.91** | 5% / 68% | 100% / 54% | 0.040 |
| Default set, logodds | 0.77 | 0.91 | 0.96 | 0.93 | 0.92 | 0.95 | 0.92 | 0.92 | TPR 0% | 0.91 | 0.90 | **0.90** | 3% / 64% | 100% / 42% | 0.047 |
| Default set, vote | 0.78 | 0.90 | 0.94 | 0.94 | 0.93 | 0.95 | 0.92 | 0.92 | TPR 0% | 0.90 | 0.89 | **0.90** | 0% / 53% | 100% / 0% | 0.049 |
| Default set, max | 0.77 | 0.87 | 0.98 | 0.90 | 0.88 | 0.95 | 0.93 | 0.92 | TPR 100% | 0.91 | 0.89 | **0.90** | 8% / 73% | 98% / 57% | 0.060 |
| Classic (tmr + perplexity) | 0.75 | 0.85 | 0.90 | 0.88 | 0.88 | 0.91 | 0.89 | 0.92 | TPR 100% | 0.87 | 0.84 | **0.86** | 2% / 47% | – / 0% | 0.050 |
| Fast (lite + perplexity) | 0.71 | 0.72 | 0.83 | 0.78 | 0.74 | 0.89 | 0.83 | 0.91 | TPR 0% | 0.77 | 0.77 | **0.77** | 3% / 31% | 100% / 1% | 0.080 |

 (score ≥ 0.75), webgpu, test half

Slop filter per genre (WebGPU path; precision / recall / human texts hidden):

| Genre | Default Fusion | Lite (auto-run) |
|---|---|---|
| forum | 100% / 41% / 0% | 100% / 20% / 0% |
| answer | 100% / 45% / 0% | 100% / 10% / 0% |
| review | 100% / 65% / 0% | 96% / 24% / 1% |
| news | 100% / 47% / 0% | 100% / 28% / 0% |
| blog | 95% / 63% / 3% | 93% / 25% / 2% |
| social | 100% / 50% / 0% | 83% / 18% / 3% |
| story | 100% / 46% / 0% | 100% / 15% / 0% |
| essay | 100% / 86% / 0% | 100% / 49% / 0% |

Forum posts and blog / how-to text are the weak spots. Reddit-style posts reach AUROC 0.81 with
the default and 0.65 with lite. wikiHow and LLMTrace "article" text is where the
filter's few false positives come from (3% of human blog texts).

### Stories and the "raw ChatGPT story at 51%" report

All AI stories in the set (fit and test halves together; default Fusion, WebGPU path):

| Source | n | Flagged (≥ 0.5) | Filtered (≥ 0.75) | Shown P(AI), mean / median |
|---|---|---|---|---|
| Our unedited default-assistant stories ("Write a short story about…") | 12 | 83% | 33% | 95% / 96% |
| LLMTrace, OpenAI models (GPT-4o, GPT-4.1, o-series) | 9 | 44% | 33% | 61% / 71% |
| LLMTrace, other 2024–25 models | 51 | 78% | 63% | 89% / 97% |
| DACTYL r/WritingPrompts stories | 60 | 77% | 50% | 92% / 97% |
| Human stories (LLMTrace, DACTYL) | 120 | 3% | 0% | – |

So an unedited assistant-voice story now typically shows **"AI 90–98%"**, against the 51%
("confidence" on the old uncalibrated scale) that was reported. The lowest of our 12 stories
shows 81%. Stories from OpenAI models in LLMTrace are the weakest group, but there are only nine of them.
Treat that row as a warning, not a number. The lite auto-run pass alone shows a mean of 69% on our
stories, so clicking for the full run matters for fiction.

### Display probability

Reliability on the test half, default Fusion (shown → fraction really AI, with n):

- WebGPU path, ECE 0.040: 6% → 4% (68), 14% → 11% (126), 26% → 21% (92), 34% → 30% (132), 44% → 49% (53), 55% → 37% (19), 65% → 56% (27), 75% → 62% (42), 85% → 83% (40), 97% → 99% (298)
- WASM path, ECE 0.040: 6% → 4% (71), 14% → 11% (124), 27% → 23% (84), 33% → 29% (140), 44% → 48% (46), 54% → 38% (21), 64% → 55% (31), 75% → 63% (48), 86% → 84% (32), 97% → 99% (300)

The middle of the range (50–80%) is thinly populated and runs about 10 points high, because
most texts land near one end. ECE for single detectors: Fakespot 0.045, TMR 0.041–0.047, lite
0.063–0.071, perplexity 0.079–0.083.

**`MIN_WORDS_FOR_SCORE` = 30.** Paragraphs of the eval texts, scored as standalone texts by the
default set and shown through the short-text curve:

| Words | 12–20 | 20–30 | 30–50 | 50–80 | 80–150 |
|---|---|---|---|---|---|
| AUROC | 0.93 | 0.91 | 0.88 | 0.84 | 0.86 |
| ECE | 0.21 | 0.23 | 0.11 | 0.07 | 0.08 |

Ranking holds even for very short text, but under 30 words the shown probability is off by
more than 20 points on average, so the UI shows "—". The rule: the smallest length from
which every bin keeps AUROC ≥ 0.75 and ECE ≤ 0.15.

### Eval set

Built by [`scripts/eval/build-eval-set.mjs`](../scripts/eval/build-eval-set.mjs). The rows are
fetched from the Hugging Face datasets-server API and cached locally; they are **not
committed**. Only our own AI samples are in the repo. Texts are 30–450 words (longer ones are
cut at a sentence boundary), so 45% are "short" (under 150 words), which is typical of
comments and reviews. Every text is assigned to a **fit** half or a **test** half by a hash
of its text. All constants were fitted on the fit half, and every number below comes from the test half.

| Source | Licence | Genres (our label) | Generators (AI side) | Human side |
|---|---|---|---|---|
| [MAGA](https://huggingface.co/datasets/anyangsong/MAGA), config MGB, validation split | MIT | forum (Reddit), answer (Yahoo Answers), review (Amazon, Trustpilot), news (CC News, NPR), blog (wikiHow) | GPT-4o-mini, Gemini-2.0-flash, DeepSeek-V3, Qwen3, Llama-3.1-8B, Mistral-Medium, Gemma-3, Hunyuan, … (12 models, 2024–25) | The same sources' human text |
| [LLMTrace](https://huggingface.co/datasets/iitolstykh/LLMTrace_classification), English, test split | Apache-2.0 | review, story, news, blog (article), answer (question), social (short_form) | GPT-4o, GPT-4.1, o3, Gemini-2.5-flash, Llama-3.3-70B, Qwen2.5/3, DeepSeek-R1-distill, Command-R, … | Included |
| [DACTYL](https://huggingface.co/datasets/ShantanuT01/DACTYL), test split (non-adversarial) | MIT | review, story (r/WritingPrompts), essay (student essays) | 11 recent LLMs, one- and few-shot | Included |
| [mild-rgb/eli5-human-vs-ai](https://huggingface.co/datasets/mild-rgb/eli5-human-vs-ai), test | CC-BY-4.0 | answer (AI side only) | 2026 models (e.g. Gemini 3.x Flash) | Not redistributed by the dataset, so not used |
| [mild-rgb/aita-human-vs-ai](https://huggingface.co/datasets/mild-rgb/aita-human-vs-ai), test | Apache-2.0 | forum (AI side only) | 2026 models (e.g. Qwen 3.x Max) | As above |
| [`scripts/calibration/web-ai.json`](../scripts/calibration/web-ai.json) | MIT (this repo) | story, forum, review, blog, answer, email, social, news, essay (67 texts) | Claude, unedited default-assistant voice ("Write a short story about…") | None (AI only) |
| MAGE test sample (T5) | Apache-2.0 | kept as a legacy check, excluded from fitting | GPT-3.5 era and older | Included |

About 1,870 web texts in total (excluding MAGE), with 60–190 per genre and class. Emails have only
our own six AI samples, so their row reports detection rate only. Neither default classifier
(TMR, lite) was trained on any of these datasets. ModernBERT was trained on MAGE's
training split (not used here). Gradient was trained on MAGA and DACTYL, which makes those rows
in-distribution for it.

### Method

1. **Browser run** ([`scripts/e2e/browser-t7-calibration.mjs`](../scripts/e2e/browser-t7-calibration.mjs)).
   The e2e build runs in Chrome for Testing 153 (Apple Silicon, shader-f16 adapter). Each
   eval text is sent as an `analyze` request, one detector at a time, on WebGPU and on WASM.
   Texts are split into page-like paragraphs, as in T5. The run records the document score, each paragraph's score, and the
   device and dtype that actually ran. The raw statistic (classifier logit, log-perplexity) is
   recovered by inverting the constants recorded with the run.
2. **Operating points** ([`scripts/eval/fit-t7.mjs`](../scripts/eval/fit-t7.mjs)), fitted on the fit
   half, per detector, device and level (document / paragraph). Each detector gets two anchors:
   - **score 0.5** is where 5% of human texts score higher (the flag point; unchanged from T5);
   - **score 0.75** is where 1% of human texts score higher, and this sets the slope.
   T5 kept T1's hand-picked slopes. On the web set they left TMR's scores squeezed below
   about 0.6, because its raw logits for human and AI text both pile up near the top.
   With two percentile anchors, a score means the same thing for every detector, and the
   stricter slop-filter threshold lands near 0.75 for each of them.
3. **Fusion weights**: a logistic regression on the detectors' log-odds (fit half, primary
   device). The weights are clipped at a minimum and scaled so the largest is 1. The
   "weighted" method renormalises them over whichever detectors are chosen.
4. **Display probability** (`toDisplayProbability`, `AnalyzeResult.probability`): isotonic
   regression of the true label on the engine score. It is fitted per detector set (every single
   detector, the presets, and the default set with each method), per device, and per length (under /
   over 150 words), on the fit half with a **50/50 human/AI mix**, then smoothed into at most 10
   linear pieces with light shrinkage towards 50%. "AI 80%" therefore means "on our web test
   texts at this length, about 80% of texts scored like this were AI-generated", *given equal
   numbers of human and AI texts*. On a page where AI text is rarer, the true rate is lower; the
   formula is `odds × (prior / (1 − prior))`. The ECE and reliability rows below are on the test half.
5. **Slop-filter threshold** (`FILTER_THRESHOLD`): the stricter of the default Fusion's and the
   auto-run model's score at 1% human FPR (fit half), and never below 0.5.
6. **Minimum words** (`MIN_WORDS_FOR_SCORE`): paragraphs of the eval texts, scored as standalone
   texts, are binned by length. Below the chosen value the default detectors' ranking (AUROC)
   falls under 0.75 and the short-text curve stops being reliable, so the UI shows "—" instead of a number.

**Slopes.** The two-anchor fit gives TMR a slope of about 18 on the WebGPU path, because its
human logits bunch up at the top. At that slope, run-to-run fp16 wobble of 0.007 in the logit
moved scores by 0.12, so slopes are capped at 6. As a result TMR alone reaches 0.75 only far
out in its tail (filter recall 0–5% when run alone). That doesn't matter in the default set,
where Fakespot carries the weight, but it is why TMR isn't the auto-run model.

### Candidates evaluated

| Candidate | Licence | ONNX | Result | Decision |
|---|---|---|---|---|
| `fakespot-ai/roberta-base-ai-text-detection-v1` (Mozilla/Fakespot) | Apache-2.0 | Not upstream. [`amankrai28/fakespot-roberta-ai-detector-onnx`](https://huggingface.co/amankrai28/fakespot-roberta-ai-detector-onnx) is an INT8 export (no licence tag, so the upstream licence applies). We exported it ourselves with optimum and quantised it: logit correlation 0.995, mean abs. difference 0.37 logits over 100 texts. | Best overall: AUROC 0.91–0.93, TPR 56% at 1% FPR | **Default** (new slot `classifierFakespot`). If upstream ever publishes ONNX, switch the pin to it. |
| TMR (`Oxidane/tmr-ai-text-detector`) | MIT | onnx-community | AUROC 0.87; weak on forum posts (0.72) | In the default set |
| e5-small LoRA (lite) | MIT | onnx-community | 0.77 | Auto-run |
| ModernBERT RAID+MAGE (`GeorgeDrayson/…`) | Apache-2.0 | onnx-community | 0.72 on web text (it was trained on MAGE; our set is newer generators) | Optional (new slot `classifierModernBert`), WASM-only |
| `tabularisai/ai-text-detection` (ModernBERT, RAID + 6 datasets) | MIT | None; we converted it for evaluation | 0.90 (Node, test half), level with Fakespot on news and stories, worse on forums | Not shipped: nothing hosted to download. Worth adding if someone publishes an ONNX export. |
| `ShantanuT01/gradient-ai-text-detector` (DeBERTa-v3-large) via `batmac/…-onnx` | MIT | q4 only (408 MB) | Constant output in our pipeline (a single-logit sigmoid head, which the engine doesn't support), and about 10 s per text on CPU | Not shipped |
| DistilGPT-2 perplexity | Apache-2.0 | Xenova | 0.72–0.73 | Optional in Fusion |
| Binoculars (SmolLM2-135M pair) | Apache-2.0 | onnx-community | 0.79, strong on essays (0.97), weak on answers | Optional, experimental, WASM-only, about 18 s per 1,000 words |

### Caveats

- One eval set, English only, 30–450-word texts. The AI side is mostly one-shot generations
  from 2024–26 models. Edited, paraphrased or "write like a human" text is not represented and will
  mostly pass.
- 45% of the texts are under 150 words, as in comments. Per-genre cells have about 50–100
  test texts, so differences under about 0.05 AUROC are noise.
- The display probability assumes equal numbers of human and AI texts. On a page where AI
  text is rarer, the real chance is lower than shown.
- Known bias: detectors like these flag non-native English writers more often (Liang et al.,
  2023). The eval set doesn't measure that.
- Fakespot's ONNX comes from a third-party export that we checked against our own. The pin is
  a fixed revision, so it cannot change underneath a release.

### Reproduce

```sh
node scripts/eval/build-eval-set.mjs --cache <dir> --n 60 --seed 11 --out eval-set.json
npm run build:e2e
node scripts/e2e/browser-t7-calibration.mjs --ext .output/chrome-mv3-e2e --eval eval-set.json --out runs.json \
  --runs webgpu:tmr,webgpu:lite,webgpu:perplexity          # WebGPU path (needs a GPU)
# WASM path + Binoculars: .github/workflows/t7-eval.yml (12-shard matrix; merged scores land on
# the t7-eval-results branch), or the same script with --runs wasm:...
node scripts/eval/fit-t7.mjs --eval eval-set.json --runs runs.json --default "fakespot+tmr|weighted" \
  --md report.md --out fit.json --emit                     # writes src/shared/displayCalibration.ts
node scripts/eval/emit-constants.mjs fit.json              # constants for src/engine/calibration.ts
```

The WebGPU runs were done locally (Chrome 153, Apple Silicon). The WASM runs were done on GitHub-hosted
Ubuntu runners (4 vCPU, Chromium from Playwright). The eval set built in CI was identical to
the local one (all 1,867 ids match).

## Deep check: which detectors (2026-09-28)

The Deep check used to average all six detectors. That set had never been measured, so it
was re-scored from the saved per-text scores (WASM run, `t7-eval-results` branch), test half:

| Set | AUROC | AI flagged (≥ 0.5) | Human flagged | Slop-filter recall |
|---|---|---|---|---|
| Fakespot + TMR (default) | **0.91** | **68%** | 5% | **54%** |
| All six, weighted | 0.90 | 63% | 3% | 11% |

No subset of the six beats Fakespot + TMR by more than noise on the fit half (the best others
are 0.89–0.90 AUROC), and Binoculars alone costs about 18 s per 1,000 words. **Deep is now
Fakespot + TMR over the whole page** (up to `maxTokens`); the Quick pass is TMR over the first
1,024 tokens, confirmed by the pair when it scores high. Settings v6 moves installs still on
the all-six default; a hand-picked Deep set is kept.

Voice: Spectra-AASIST3 stays the only voice model offered by default; W2V2-AASIST is clearly
worse on the same clips (EER 7–9% and 37–65% of human clips flagged, against 2–3% and 0%;
docs/voice-spike.md), so a "deeper" voice check samples more of the video instead.

## Quick tier and false positives (QA pass, 2026-09-28)

The release QA found the automatic Quick check putting high numbers on plainly human
pages: a TED talk transcript at "AI 53%", an r/AskHistorians thread at 95%. Causes, fixes and
before/after numbers.

**Causes.**
1. **The Quick model.** Lite (e5-small, AUROC 0.77) calibrated honestly still shows ≥ 50% on
   41% of human web texts (news 60%, blog/how-to 78%), and the old chip threshold (35%) let it
   show on 76% of human pages.
2. **Transcript curves fitted on the wrong path.** The lite transcript curve pooled punctuated
   *and* unpunctuated captions for every item, although the Quick pass never scores
   unpunctuated auto-captions. Lite scores unpunctuated AI text near 0, so the bottom of the curve
   sat at 36–60% "AI". A human TED talk (lite score ≈ 0.003) read 53%.
3. **Per-item labels used the wrong curve.** Comments, reviews and search snippets are scored on
   the paragraph scale but were mapped through the default Fusion *document* curve, whatever
   detector ran. Sentence tooltips showed the raw engine score as a percentage.

**Fixes.**
- **Quick = TMR** (already downloaded for Fusion; ~0.4 s per 1,000 words on WebGPU, twice lite).
  Lite stays selectable. Settings v3 moves anyone still on the old defaults.
- **Confirm before showing.** A Quick result that reads ≥ 50% (or has any item past the
  slop-filter threshold) is re-checked with the default Fusion set before anything is shown
  (`tiers.confirmQuick`, on by default; Options → Quick detectors). This costs a Fusion run
  (Fakespot is WASM-only: ~7 s per 1,000 words on an M-series Mac) on flagged pages only.
- **Chip from 70%** (was 35%): "chip only if high".
- **Transcript curves** refitted per caption type (punctuated → `punct`, unpunctuated → `raw`);
  Quick curves see punctuated captions only. TMR transcript curve added.
- **Per-item curves** (`…|unit`): fitted on whole texts under 150 words (what a comment or review
  is) mapped with the paragraph operating points. Labels, filter badges, snippet markers and
  sentence tooltips now use the curve of the detector set that ran.

**Web eval set, test half, WebGPU** (shown P(AI); `fit-t7.mjs`, "What the reader sees"):

| Quick pass | human ≥ 50% | human ≥ 70% (chip) | forum / news / blog human ≥ 50% | AI ≥ 70% | median human / AI |
|---|---|---|---|---|---|
| Before: lite | 41% | 11% | 35% / 60% / 78% | 51% | 45% / 72% |
| TMR alone | 16% | 6% | 23% / 37% / 25% | 65% | 34% / 87% |
| Fusion alone (for reference) | 12% | 6% | 10% / 16% / 23% | 74% | 26% / 96% |
| **After: TMR, confirmed by Fusion at ≥ 50%** | **3%** | **2%** | 0% / 6% / 7% | 67% | 30% / 96% |

The confirm step runs on 16% of human texts and 75% of AI texts. A text is shown ≥ 50% only
when both TMR and Fusion say so, which is why the cascade beats either alone on false positives
while keeping most of Fusion's recall.

Per-item labels (texts under 150 words, paragraph scale): lite shows ≥ 50% on 46% of human
items and ≥ 70% on 11%; TMR 8% / 3% (forum posts 24% / –); Fusion 11% / 8%, AI ≥ 70% 69%.

**Transcripts** (test half, punctuated captions, whole transcripts, shown ≥ 50% / ≥ 70%):

| | human speech | human prose read aloud | AI scripts + AI web text |
|---|---|---|---|
| Lite, old curve | 7% / 7% | 45% / 11% | 78% / 62% |
| Lite, refitted | 7% / 3% | 24% / 6% | 63% / 45% |
| TMR (Quick default) | 10% / 3% | 6% / 6% | 50% / 40% |
| Fusion (confirm step, refitted) | 7% / 3% | 10% / 2% | 82% / 78% |

TMR ranks transcripts worse than lite (AUROC 0.74 against 0.83, Node CPU) but is no worse at the
high end, and anything ≥ 50% is confirmed by Fusion (AUROC 0.93).

**Live check, real Chrome, default settings** (Quick pass as shown; "old" = lite, the previous default):

| Page | Words | Old (lite) | New |
|---|---|---|---|
| TED talk transcript (Ken Robinson) | – | 53% | 23% (TMR) |
| r/AskHistorians thread | 729 | 95% | 41% (TMR) |
| Wikipedia "Hedgehog" | 2,529 | 82% | 34% (confirmed) |
| BBC News article 1 | 1,182 | 52% (TMR alone: 77%) | 47% (confirmed) |
| BBC News article 2 | 679 | 82% | 69% (confirmed; chip stays hidden) |
| Slate Star Codex, 2014 essay | 2,959 | 86% | 20% (TMR) |
| Fresh unedited AI story (written for this test) | 334 | 83% | 98% (confirmed) |
| Fresh AI how-to answer | 291 | 88% | 98% (confirmed) |
| Fresh AI product review | 259 | 84% | 98% (confirmed) |
| Fresh AI forum post | 195 | 95% | 98% (confirmed) |

Caveats: the eval set is the T7/T10 one (not re-collected), the live pages are a handful, and
news and how-to text remain the weakest human genres (6–7% still read ≥ 50% after
confirmation). Not tuned on the pages above: every constant comes from the fit half.

## Transcripts (T10, YouTube, 2026-09-27)

The transcript chip ("Transcript: AI 84%") uses its own display mapping
([`src/shared/transcriptCalibration.ts`](../src/shared/transcriptCalibration.ts),
`toTranscriptProbability()` in [`src/shared/transcript.ts`](../src/shared/transcript.ts)),
because captions don't read like web text. It measures **AI-written scripts**, not synthetic
voices. The eval set is small (419 texts, 208 in the test half), so read the numbers as
±0.03–0.05 AUROC.

**What ships.**
- Punctuated captions (uploaded tracks, and most 2026 YouTube auto-captions) are cut into
  sentences.
- Classic unpunctuated auto-captions are scored as plain caption lines ("raw").
- Transcripts are scored in blocks of about 160 words, with sentence start times kept for
  seeking. Long videos are sampled evenly up to the token budget.
- The full run is the default Fusion. The automatic pass (lite) only scores punctuated
  transcripts, because on unpunctuated captions it is near chance (AUROC 0.69).

### Eval set

Built by [`scripts/eval/transcripts/build-transcript-set.mjs`](../scripts/eval/transcripts/build-transcript-set.mjs).
Rows are fetched from the HF datasets-server and cached, not committed.

| Side | Source | Licence | n |
|---|---|---|---|
| Human speech | [People's Speech](https://huggingface.co/datasets/MLCommons/peoples_speech) "clean" test (archive.org talks, lectures, hearings) | CC-BY-4.0 | 139 with Earnings-22 |
| Human speech | [Earnings-22](https://huggingface.co/datasets/distil-whisper/earnings22) chunked test (earnings calls) | CC-BY-SA-4.0 | (above) |
| Human prose read aloud | T7 web set, human news / blog / story / answer | MIT / Apache-2.0 | 120 |
| AI | [`scripts/calibration/transcript-ai.json`](../scripts/calibration/transcript-ai.json): 40 voiceover scripts (facts, documentary, listicle, true-crime, review…) | MIT (this repo; Claude) | 40 |
| AI | T7 web set, AI news / blog / story / answer | as T7 | 120 |

Every text gets word timings: real segment timing for speech, and a TTS-like reading pace
with pauses at punctuation for written text. It is then cut into YouTube-style caption lines
of 4–10 words ([`cues.mjs`](../scripts/eval/transcripts/cues.mjs)). Conditions:
`punct` keeps punctuation and case. `raw` is lowercase with no punctuation, one caption line per unit.
`pause` is the same text cut into pseudo-sentences at pauses of ≥ 0.5 s (capital + full stop).
`pause-panel` is the same using only the panel's whole-second start times. `restored` is the
raw text run through [1-800-BAD-CODE/punctuation_fullstop_truecase_english](https://huggingface.co/1-800-BAD-CODE/punctuation_fullstop_truecase_english)
(Apache-2.0, ONNX, 210 MB) offline. Scored in Node (CPU, WASM constants) through the engine
and the shipped chunker ([`score-transcripts.mjs`](../scripts/eval/transcripts/score-transcripts.mjs)).
Fitted with [`fit-transcripts.mjs`](../scripts/eval/transcripts/fit-transcripts.mjs).

### Results (test half)

#### Default Fusion (Fakespot + TMR)

| Condition | AUROC all | vs speech | vs human prose | AI: own scripts / web AI flagged | flag FPR / TPR (≥ 0.5) | filter precision / recall (≥ 0.75) |
|---|---|---|---|---|---|---|
| punct | **0.94** | 0.95 | 0.93 | 91% / 63% | 1% / 70% | 100% / 44% |
| raw | **0.82** | 0.85 | 0.79 | 36% / 32% | 1% / 33% | 100% / 22% |
| pause | **0.78** | 0.75 | 0.82 | 0% / 10% | 0% / 7% | 100% / 6% |
| pause-panel | **0.73** | 0.69 | 0.77 | 0% / 0% | 0% / 0% | – / 0% |
| restored | **0.91** | 0.91 | 0.92 | 68% / 39% | 1% / 47% | 100% / 22% |

(test half: 208 texts)

Display (long, path punct + raw), test ECE **0.06** (406 points): 25% → 21% (195), 34% → 37% (39), 45% → 63% (27), 54% → 73% (9), 65% → 29% (9), 76% → 76% (14), 86% → 97% (26), 96% → 99% (88)

Display (short, path punct + raw), test ECE **0.04** (576 points): 24% → 22% (261), 36% → 53% (23), 45% → 40% (66), 54% → 57% (50), 66% → 76% (19), 76% → 81% (23), 86% → 97% (44), 96% → 98% (90)

#### Lite (auto-run)

| Condition | AUROC all | vs speech | vs human prose | AI: own scripts / web AI flagged | flag FPR / TPR (≥ 0.5) | filter precision / recall (≥ 0.75) |
|---|---|---|---|---|---|---|
| punct | **0.86** | 0.92 | 0.79 | 5% / 17% | 0% / 14% | 100% / 5% |
| raw | **0.69** | 0.68 | 0.69 | 0% / 3% | 0% / 2% | – / 0% |
| pause | **0.71** | 0.71 | 0.70 | 0% / 3% | 0% / 2% | 100% / 1% |
| pause-panel | **0.68** | 0.70 | 0.66 | 0% / 0% | 0% / 0% | – / 0% |
| restored | **0.80** | 0.84 | 0.75 | 5% / 10% | 0% / 9% | 100% / 2% |

(test half: 208 texts)

Display (long, path punct + raw), test ECE **0.04** (406 points): 36% → 34% (237), 44% → 55% (36), 56% → 64% (18), 65% → 62% (36), 75% → 72% (32), 83% → 97% (29), 95% → 100% (17)

Display (short, path punct + raw), test ECE **0.15** (576 points): 16% → 35% (337), 23% → 51% (32), 35% → 48% (10), 48% → 59% (20), 54% → 54% (22), 66% → 70% (17), 76% → 71% (33), 85% → 78% (67), 92% → 97% (37)

### Findings

- **Punctuated captions work about as well as web text**: Fusion AUROC 0.94, 1% of human
  transcripts flagged. Our own AI voiceover scripts are flagged 91% of the time.
- **Unpunctuated auto-captions cost a lot**: AUROC 0.82, and only a third of AI scripts are
  flagged at the 5%-FPR point. The false-positive rate stays at 1%, so a high score is still
  meaningful. It just fires much less often.
- **Cheap pause segmentation did not help. It hurt** (0.78; 0.73 with the panel's whole-second
  timestamps). Inserting our own capitals and full stops at pauses makes human speech look
  more "written" to the classifiers. It is kept in the chunker for experiments, not shipped.
- **A punctuation-restoration model recovers most of the loss** (0.82 → 0.91). It is not
  shipped: it is a 210 MB download with a SentencePiece tokenizer that transformers.js can't
  load as is. It's a reasonable follow-up if a small tokenizer.json export appears.
- **Display mapping** (default Fusion, pooled `punct` + `raw`): test ECE 0.06 on whole
  transcripts and 0.04 on single segments. The fastest pass is weaker (ECE 0.15 on segments).
  Shown % never goes below about 23%, because on this set about a fifth of the lowest-scoring
  transcripts are AI (mostly unpunctuated ones).

### Caveats

- Scripted human narration is represented only by human *written* prose. Real human
  voiceover scripts, and AI scripts that a person has edited or ad-libbed, are not measured.
- The timings for written texts are synthetic. The "speech" side is mostly public-meeting and
  earnings-call talk, not vlogs.
- English only. Non-English transcripts show "Transcript: English only".
- The live YouTube pipeline (panel reading, SPA navigation, seeking) was checked by a single
  sanity run on one public video (panel read hidden in 0.8 s, 414 cues, panel closed
  afterwards). Browser E2E runs in CI.

### Reproduce

```sh
node scripts/eval/transcripts/build-transcript-set.mjs --cache <dir> --eval eval-set.json --out transcript-set.json
node scripts/eval/transcripts/score-transcripts.mjs --set transcript-set.json --dump-normalised norm.json
python scripts/eval/transcripts/restore-punctuation.py norm.json restored.json   # pip install punctuators
for m in fusion lite; do
  node scripts/eval/transcripts/score-transcripts.mjs --set transcript-set.json --mode $m \
    --restored restored.json --out scores-$m.json --cache <model cache>
done
node scripts/eval/transcripts/fit-transcripts.mjs --set transcript-set.json \
  --scores fusion=scores-fusion.json,lite=scores-lite.json --ship-unpunct raw --md report.md --emit
```


---

# Previous calibrations (kept for reference)

## T5 (2026-09-27): browser re-calibration on MAGE

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

### Paragraph-level thresholds (sentence colours and "flagged")

The document-level constants above set the page's **overall** score.
Sentence colours and the "flagged" count come from **paragraph-sized**
pieces of text. These are much shorter and noisier than a document, so they
use their own operating points (`CALIBRATION.unit`):

- **Classifier.** Sentence colours come from one chunk per paragraph (text.ts
  `packChunks(…, splitEveryBlock)`), so human and AI paragraphs are never
  averaged together. The overall score still uses document-sized chunks.
- **Perplexity.** Each scoring unit (≥ `minWords` words, kept within a paragraph
  where possible) is compared with the unit threshold.
- **Fit.** `scripts/e2e/browser-unit-calibration.mjs` runs the same texts in the
  extension, split into page-like paragraphs (single-paragraph MAGE texts are cut into pieces of
  ≥ 60 words). That gives about 965 human and 895 AI paragraphs. Each threshold sits
  where about 5% of human paragraphs score higher, with the same slopes.

| Paragraph level (WASM) | Threshold | AUROC | AI paragraphs flagged at the threshold |
|---|---|---|---|
| TMR logit centre | 4.20 (document 3.84) | 0.80 | 42% |
| Lite logit centre | 2.34 (document 2.70) | 0.73 | 24% |
| Perplexity τ (log-PPL) | 3.02 (document 3.17) | 0.66 | 21% |

WebGPU: TMR 3.87, lite 2.22, τ 2.81.

Page scans also drop headings, captions and blocks under 12 words
(`proseBlocks`). Before, these were scored and, being too short to score alone,
folded into the next paragraph's unit.

**Fixture check (E2E regression test, `per-paragraph flag rates`).** On
`news.html` (ensemble, WASM, Chrome and Firefox), **0 of 22** sentences in the
public-domain USGS/NWS paragraphs are flagged, and **13 of 17 (76%)** in the
LLM-written paragraphs. On `blog.html`, 0 of 33 human sentences are flagged. The test fails if
more than 20% of human sentences are flagged, if AI paragraphs aren't flagged more
often, or if anything outside the labelled paragraphs is flagged. It also checks that the
pill and the popup report the same count.

Before this change, most of `news.html` was flagged, including the headline, byline,
captions and the USGS paragraphs. The causes:
1. Headings and captions were folded into paragraph units.
2. Classifier chunks of up to 384 tokens spanned several paragraphs, mixing human and AI text.
3. Paragraph-sized pieces were mapped with document-level constants. Short text reads
   as more AI-like to these detectors, so human paragraphs crossed 0.5.
4. Re-analysing a page read the extension's own `⟦ZW⟧` markers as page text.

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
