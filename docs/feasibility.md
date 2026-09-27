# Feasibility: local AI-text detector extension (Chrome + Firefox, MV3)

Investigated 2026-09-27. Evidence comes from Hugging Face API file listings, npm, vendor docs, and
Node prototypes run locally (scratchpad, not committed) against the real model files.

## TL;DR verdict

| Mode | Verdict | Model(s) | Download (quantized) |
|---|---|---|---|
| 1. Classifier | **Feasible, verified** | `onnx-community/tmr-ai-text-detector-ONNX` (RoBERTa-base, RAID-trained) | 126 MB (q8) |
| 2. Perplexity / burstiness | **Feasible, verified** (logits exposed) | `Xenova/distilgpt2` (`decoder_model_merged`, q8) | 85 MB |
| 3. Binoculars | **Feasible, verified** with a small pair; accuracy unproven at this scale, so ship as "experimental" | `onnx-community/SmolLM2-135M-ONNX` + `onnx-community/SmolLM2-135M-Instruct-ONNX` | 2 × 117 MB (q4f16) / 2 × 136 MB (q8) |
| 4. Ensemble (1+2, default) | **Feasible** | the models from 1 and 2 | ~211 MB total |

Nothing blocks the project. The main platform gap is **Firefox**: it has no offscreen API, no
cross-origin isolation for extension pages (so WASM runs single-threaded), and WebGPU is missing on
Linux. It works there, just more slowly.

---

## 1. Where inference runs

### Chrome (MV3)
- **Recommended: an offscreen document** (`chrome.offscreen.createDocument`, reason `WORKERS`).
  The service worker only routes messages.
  - Only one offscreen document can exist per extension. Reasons other than `AUDIO_PLAYBACK`
    have no lifetime limit, so the loaded model stays in memory.
    The only extension API available inside it is `runtime`.
    ([Chrome offscreen docs](https://developer.chrome.com/docs/extensions/reference/api/offscreen))
  - Why not the service worker: Chrome suspends it after about 30 s idle, which throws away the
    loaded sessions. Service workers cannot create `Worker`s, so ORT WASM threads are impossible
    there. `import()` is also disallowed in service workers, and ORT dynamically imports its `.mjs`
    glue. ([dev.to write-up](https://dev.to/sathiyasenpai/why-i-moved-my-transformersjs-pipeline-out-of-the-chrome-mv3-service-worker-and-into-an-offscreen-1kk4),
    [transformers.js #787](https://github.com/xenova/transformers.js/issues/787))
    WebGPU does work in service workers since Chrome 124
    ([Chrome blog](https://developer.chrome.com/blog/new-in-webgpu-124)), and the HF blog example
    runs inference in the service worker
    ([HF blog](https://huggingface.co/blog/transformersjs-chrome-extension)). We still pick
    offscreen for model persistence and WASM threads.
- **WASM threads**: add `"cross_origin_embedder_policy": {"value": "require-corp"}` and
  `"cross_origin_opener_policy": {"value": "same-origin"}` to the manifest. Extension pages,
  including the offscreen doc, then become `crossOriginIsolated`, which enables SharedArrayBuffer and
  multi-threaded ORT
  ([Chrome cross-origin isolation](https://developer.chrome.com/docs/extensions/develop/concepts/cross-origin-isolation)).
  Hugging Face reflects the request `Origin` in `Access-Control-Allow-Origin` (verified with curl
  using `Origin: chrome-extension://…`), so CORS fetches of the models still pass under COEP.
- **WebGPU**: available in documents on Mac, Windows and ChromeOS since Chrome 113, on Linux since
  144/147 depending on GPU
  ([gpuweb status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)).

### Firefox (MV3)
- `background.service_worker` is **not supported**. Firefox runs `background.scripts` as a
  non-persistent **event page**, which is a full DOM document that can create Workers and use
  WebGPU. One manifest can declare both `scripts` and `service_worker`; each browser picks its own
  ([MDN background](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)).
- There is no offscreen API, so run inference in a dedicated `Worker` spawned from the event
  page. The event page is unloaded when idle, so treat sessions as disposable and re-create them.
  Models come back from the cache, so a reload takes seconds.
- **No cross-origin isolation for extension pages.** The COEP/COOP manifest keys are unsupported
  ("unexpected property") and the fix needs per-extension processes
  ([bug 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477), reopened). This means
  **ORT WASM is single-threaded on Firefox**: set `env.backends.onnx.wasm.numThreads = 1`.
- **WebGPU**: Windows since 141, Apple Silicon macOS since 145, other macOS since 147,
  **Linux not yet** (Nightly only)
  ([gpuweb status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)).

### CSP, permissions, store rules
- CSP (both browsers): `"content_security_policy": {"extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"}`.
  This is Chrome's allowed minimum and cannot be relaxed further
  ([Chrome CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)).
  Firefox MV3 allows only `'self'`, `'none'` and `'wasm-unsafe-eval'` in `script-src`
  ([MDN CSP](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy)).
- **WASM must be bundled.** Chrome Web Store counts WASM as remotely hosted code; data such as
  model weights and JSON is allowed
  ([Chrome RHC](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)).
  **Gotcha, verified in `@huggingface/transformers@4.3.0` source:** outside a service worker, if
  `wasmPaths` is unset, transformers.js points ORT at
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@<ver>/dist/`. We **must** set
  `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/')` (or `{mjs, wasm}` URLs)
  before loading any model
  ([transformers.js #1248](https://github.com/huggingface/transformers.js/issues/1248) shows the failure).
  - transformers.js v4 imports `onnxruntime-web/webgpu` and uses
    `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`. The `.wasm` is **26 MB**. Copy both into the
    build output and list them in `web_accessible_resources` if needed. Chrome has no problem with
    this size. AMO's limit is 200 MB per package
    ([AMO submission](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)).
- **AMO source submission**: bundled or minified code requires uploading source code plus build
  instructions ([AMO source code](https://extensionworkshop.com/documentation/publish/source-code-submission/)).
- Permissions: `offscreen` (Chrome only), `storage`, `activeTab` + `scripting` (inject the
  highlighter on demand) or a `content_scripts` entry, and `host_permissions` for
  `https://huggingface.co/*` and `https://*.hf.co/*`. The file endpoints 302-redirect to
  `us.aws.cdn.hf.co/xet-bridge-us/…`, verified. CORS already allows this without host permissions,
  but declaring them avoids surprises.

## 2. Models (verified via `huggingface.co/api/models/<id>/tree/main/onnx`)

### Mode 1: Classifier
ONNX AI-text classifiers **already exist** as transformers.js-ready `onnx-community` ports, so no
conversion is needed.

| Model ID | Base | q8 (`model_quantized.onnx`) | q4f16 | Notes |
|---|---|---|---|---|
| **`onnx-community/tmr-ai-text-detector-ONNX`** (recommended) | RoBERTa-base, labels `human`/`ai`, 512 tok | 125.9 MB | 127.5 MB | Source [`Oxidane/tmr-ai-text-detector`](https://huggingface.co/Oxidane/tmr-ai-text-detector), MIT. Card claims RAID AUROC 99.28% (all settings), TPR 90% at 1% FPR |
| `onnx-community/modernbert-ai-detection-raid-mage-ONNX` | ModernBERT-base, 8k ctx | 150.9 MB | 140.2 MB | RAID + MAGE, Apache-2.0 |
| `onnx-community/e5-small-lora-ai-generated-detector-ONNX` | e5-small (BERT) | **34.2 MB** | 36.5 MB | Small and fast; offer as a "lite" option |
| `onnx-community/chatgpt-detector-roberta-ONNX` | RoBERTa (HC3) | 125.9 MB | 127.5 MB | ChatGPT-era data |
| `onnx-community/roberta-base-openai-detector-ONNX` | RoBERTa (GPT-2 outputs) | 125.9 MB | 127.5 MB | The requested one. Trained on GPT-2 output and weak on modern LLMs, so don't make it the default |

Prototype (Node, transformers.js 4.3.0, `pipeline('text-classification', …, {dtype:'q8'})`):
- It works. Casual human sentence gave `ai 0.82`, a **false positive on short text**. Formal
  AI-style paragraph gave `ai 0.987`.

If a new detector without ONNX is ever wanted, convert it with
`pip install "optimum[onnx]"`, then
`optimum-cli export onnx --model <hf-id> --task text-classification out/`, then quantize with
transformers.js `scripts/quantize.py` (or `optimum-cli onnxruntime quantize`) and place the files
in the `onnx/` subfolder with `model_quantized.onnx` naming.

### Mode 2: Perplexity / burstiness (GPTZero-style)
- **Logits are exposed**, verified: `await AutoModelForCausalLM.from_pretrained(id)(tokenizer(text))`
  returns `logits` with dims `[1, T, 50257]`. Per-token log-probs are
  `logits[i, ids[i+1]] - logsumexp(logits[i])`. Perplexity is the mean over the text; burstiness
  is the variance of per-sentence perplexity. Per-token scores give sentence-level highlighting
  from a single forward pass.
- Prototype: distilgpt2 PPL 62.9 (human) vs 28.3 (AI-style). The direction is as expected.
- **Use `Xenova/distilgpt2`, `{dtype:'q8', model_file_name:'decoder_model_merged'}` = 85 MB.**
  Gotcha: that repo's `model_quantized.onnx` is 237 MB and isn't really compressed, while the
  merged-decoder q8 is.
  `Xenova/gpt2` only has `decoder_model_merged_quantized.onnx` (128 MB). Default loading fails
  with "Could not locate file model_quantized.onnx", so `model_file_name` is required there too.
- Max context is 1024 tokens. Chunk long pages with a sliding window.

### Mode 3: Binoculars
- Score = log-PPL under the performer ÷ cross-perplexity (observer softmax · performer log-softmax).
  Both models need an identical tokenizer
  ([paper](https://arxiv.org/html/2401.12070v3), which uses Falcon-7B / Falcon-7B-instruct).
- **Recommended pair:** `onnx-community/SmolLM2-135M-ONNX` (observer) +
  `onnx-community/SmolLM2-135M-Instruct-ONNX` (performer). Verified that the token IDs match
  (vocab 49152). q4f16 is 117 MB each (the base uses `.onnx` + `.onnx_data` external data);
  q8 is ~136 MB each, and q8 should be used on WASM.
- Prototype: Binoculars score **0.869 (human) vs 0.659 (AI-style)**, lower meaning more AI, as
  expected. Two forward passes over about 50 tokens took ~120 ms on CPU.
- Larger options: `onnx-community/SmolLM2-360M-ONNX` + `HuggingFaceTB/SmolLM2-360M-Instruct`
  (q4f16 272 MB each), or `onnx-community/Qwen2.5-0.5B` + `-Instruct` (q4f16 483 MB each, ~1 GB
  total). These are too heavy for a default.
- Caveat: the published Binoculars accuracy is for 7B models. With 135M models the threshold must
  be calibrated by us, and accuracy will be clearly lower. **Ship it as "experimental".**
  gpt2/distilgpt2 share a tokenizer but aren't a base/instruct pair, so they are a poor Binoculars
  choice.

### Mode 4: Ensemble (default)
`p = w1·classifier_p + w2·sigmoid(a·(τ − log PPL) + b·(τ_b − burstiness))`. Calibrate `τ`, `a`
and the weights on a small labelled set, e.g. a RAID sample. Total download is ~211 MB
(126 + 85). Latency is roughly classifier + LM.

## 3. Caching
- transformers.js caches with the **Cache API** (`env.useBrowserCache`, default true when
  `caches` exists) under the extension origin. That gives one cache per install, shared by all
  tabs. The WASM binary is cached via `env.useWasmCache`.
- Settings to use in the extension:
  ```js
  import { env } from '@huggingface/transformers';
  env.allowLocalModels = false;           // don't probe /models/ inside the extension
  env.allowRemoteModels = true;           // download from huggingface.co once
  env.useBrowserCache = true;
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/'); // bundled, never CDN
  env.backends.onnx.wasm.numThreads = isFirefox ? 1 : Math.min(4, navigator.hardwareConcurrency);
  // Fallback if Cache API is unavailable (e.g. Firefox private windows):
  // env.useCustomCache = true; env.customCache = { match, put } backed by IndexedDB/OPFS.
  ```
- **Unverified:** Cache API behaviour on `moz-extension://` event pages and workers, especially
  in private browsing. Check this in the first spike and keep the `customCache` IndexedDB fallback
  ready.
- Call `navigator.storage.persist()` so the browser doesn't evict ~200–500 MB of models. Show
  download progress with the `progress_callback` option.

## 4. Build tooling
**WXT** (`wxt@0.21.4`, Vite-based) is recommended.
- `wxt build -b chrome` and `wxt build -b firefox --mv3` come from one codebase. The manifest is
  generated per browser (verified in `wxt/dist/core/utils/manifest.mjs`: it emits `background.service_worker` for Chrome and `background.scripts`
  for Firefox), and `import.meta.env.FIREFOX` handles branching
  ([WXT browser targets](https://wxt.dev/guide/essentials/target-different-browsers)).
  Note that WXT defaults Firefox to MV2, so pass `--mv3` or set `manifestVersion: 3`.
- `wxt zip -b firefox` also produces the sources zip AMO requires.
- Put the ORT `.mjs` and `.wasm` in `public/ort/` (copied from `node_modules/onnxruntime-web/dist/`
  and pinned to the version transformers.js depends on). Keep transformers.js out of content
  scripts.
- Alternatives: Plasmo (0.90.x, heavier, React-centric, slower cadence) and CRXJS (Chrome-first).
  WXT has the cleanest dual-browser output.

## 5. Latency (measured) and expectations
ORT-Web **WASM** in Node on an Apple M5, 512-token input, q8, warm run:

| Model | 1 thread (Firefox-like) | 4 threads (Chrome + COI) |
|---|---|---|
| TMR RoBERTa classifier | 1.94 s | 0.76 s |
| GPT-2 124M (merged q8) | 2.67 s | 1.05 s |

- distilgpt2 is about half GPT-2's depth, so expect ~0.5–1.3 s per 512-token chunk.
- The SmolLM2-135M pair is two passes of a ~GPT-2-sized model with a smaller vocab, so expect
  ~2–5 s per 512-token chunk on WASM.
- WebGPU should be several times faster for the LMs, but it is untested here and needs a real
  browser.
- An average article is 1–3k tokens. Expect **~2–10 s for a full-page ensemble on WASM** and
  about 1–2 s on WebGPU. Stream per-chunk results to the UI and cap analysed text at around
  4k tokens by default.
- First run adds the one-off download (~211 MB for the default) plus 1–3 s session creation.

## 6. Accuracy caveats (put these in the UI)
- No detector is reliable enough for accusations. Paraphrasing attacks strongly reduce detection
  ([RAID](https://arxiv.org/abs/2405.07940)). Perplexity-style detectors flag non-native English
  writers at high rates: a 61% false-positive rate on TOEFL essays (Liang et al. 2023, *Patterns*).
- Short text (under ~50 words, e.g. single sentences) is noisy. Our own prototype gave a casual
  human sentence an AI score of 0.82. Only show scores for chunks above ~100 tokens, and treat
  per-sentence highlights as a relative heat-map, not as verdicts.
- The models are English-only.
- The TMR card metrics are the author's own RAID numbers, so expect worse results on
  out-of-distribution text such as new LLMs, code, and lists.
- GPT-2 perplexity is a weak signal against modern models. That is why the ensemble exists.
- Binoculars with 135M models has no published validation.

## 7. Recommended architecture
```
content script ──(text blocks, sentence offsets)──► background
  (extract visible text via Readability-like walk,       │ Chrome: service worker → chrome.offscreen doc (WORKERS)
   render per-sentence <mark> highlights)                │ Firefox: event page → dedicated Worker
                                                          ▼
                               inference host: transformers.js 4.x + bundled ORT wasm
                               device: 'webgpu' if navigator.gpu?.requestAdapter() else 'wasm'
                               dtype: q4f16 on WebGPU (shader-f16), q8 on WASM
                               modes: classifier | perplexity | binoculars(exp.) | ensemble
                                                          │
popup (gauge, mode select, download status) ◄──── results / progress via runtime messaging
settings in storage.sync; models in Cache API (IndexedDB fallback)
```
- Pipeline:
  1. Split the page into sentences with `Intl.Segmenter`, then into ≤512-token chunks.
  2. Run the classifier per chunk.
  3. Run LM per-token log-probs per chunk, mapped back to sentences.
  4. Aggregate with a length-weighted mean for the gauge.
  5. Cache results per URL and content hash.
- Load models lazily per mode. Sessions are re-creatable, since the Firefox event page and a
  Chrome offscreen recreation can both drop them.

## Blockers / risks
1. **Firefox has no WASM multithreading** (bug 1673477) and **no WebGPU on Linux**. Firefox runs
   about 2.5× slower on CPU. This isn't a blocker.
2. **transformers.js falls back to the jsDelivr CDN for the WASM files** unless `wasmPaths` is set.
   That would fail store review, so it must be overridden.
3. The Cache API in Firefox extension contexts is unverified, so keep an IndexedDB fallback ready.
4. Binoculars accuracy with small models is unknown and needs calibration data.
5. The ~200 MB first-run download needs a clear consent and progress UI.
