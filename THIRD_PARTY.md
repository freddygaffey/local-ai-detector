# Third-party software, models, and data

Local AI Detector is MIT-licensed (see [`LICENSE`](LICENSE)). It bundles the
following open-source libraries and, at runtime, downloads the following
openly-licensed models from Hugging Face. Nothing non-commercial, gated, or
without a clear open licence is bundled or recommended by default — see
[`docs/feasibility.md`](docs/feasibility.md)  §8 and
[`docs/watermarks.md`](docs/watermarks.md) for the research and exclusions
behind these choices.

## Bundled libraries (shipped inside the extension package)

| Library | Version | Licence | Source | Notes |
|---|---|---|---|---|
| [`@huggingface/transformers`](https://github.com/huggingface/transformers.js) | 4.3.0 | Apache-2.0 | github.com/huggingface/transformers.js | In-browser ML inference (tokenizers, model runners). Its bundled LICENSE ships at `public/licenses/@huggingface__transformers.LICENSE.txt`. |
| [`onnxruntime-web`](https://github.com/microsoft/onnxruntime) | 1.31.0-dev.20260914-8d85527a0 | MIT | github.com/microsoft/onnxruntime | The WASM backend that runs every model. Only the threaded-SIMD ("asyncify") WASM pair is bundled (`public/ort/`), never fetched from a CDN (`src/engine/runtime.ts` sets `wasmPaths` to the packaged copies and refuses to run otherwise; a build-time transform also dead-strips transformers.js's jsDelivr fallback string). This version ships no LICENSE file in its npm package; the real upstream MIT text and `ThirdPartyNotices.txt` (covering code it bundles internally) were fetched from the exact matching GitHub commit and are committed at [`licenses/vendor/onnxruntime-web/`](licenses/vendor/onnxruntime-web/) — see that folder's README for how the commit was identified. |
| [`@contentauth/c2pa-web`](https://github.com/contentauth/c2pa-js) (+ `@contentauth/c2pa-wasm`, `@contentauth/c2pa-types`, `@contentauth/c2pa-utilities`) | 0.15.2 | MIT | github.com/contentauth/c2pa-js | C2PA / Content Credentials validation (signature, hash, trust-chain), running against the bundled trust list below. Remote manifest fetching and OCSP are explicitly disabled so validation never leaves the browser. WASM + worker script under `public/c2pa/`. |
| [`c2pa-text`](https://github.com/encypherai/c2pa-text) | 3.0.0 | MIT | github.com/encypherai/c2pa-text | Detects C2PA text manifests (Unicode-variation-selector encoding) in page text. Ships no LICENSE in its npm package; the real upstream text (tag `v3.0.0`) is committed at [`licenses/vendor/c2pa-text/`](licenses/vendor/c2pa-text/). |
| [`exifreader`](https://github.com/mattiasw/ExifReader) | 4.46.0 | MPL-2.0 | github.com/mattiasw/ExifReader | Reads EXIF/IPTC/XMP metadata from images (generator tags, `DigitalSourceType`, etc.). Used unmodified; its MPL notice ships at `public/licenses/exifreader.LICENSE.txt`. MPL-2.0 is file-level copyleft: only modifications to ExifReader's *own* files would need to stay MPL, and none were made. |
| [`wxt`](https://github.com/wxt-dev/wxt) | 0.21.4 | MIT | github.com/wxt-dev/wxt | Build tool only; not bundled in the shipped extension. |

Every LICENSE file above is regenerated into `public/licenses/` by
[`scripts/copy-vendor-assets.mjs`](scripts/copy-vendor-assets.mjs) on every
build, which **fails the build** if a bundled dependency has neither an
npm-shipped licence file nor a real upstream text committed under
[`licenses/vendor/`](licenses/vendor/). Verify what actually ships with
`npm run build && ls .output/chrome-mv3/licenses/`.

## Code we wrote ourselves, ported or adapted from other open-source projects

| File(s) | Adapted from | Original licence | Notes |
|---|---|---|---|
| [`src/provenance/dwtdct.ts`](src/provenance/dwtdct.ts) | [`ShieldMnt/invisible-watermark`](https://github.com/ShieldMnt/invisible-watermark) (Python reference `dwtDct` decoder) | MIT | Our own from-scratch JS/TypeScript port (BGR→YUV, 1-level Haar DWT, 4×4 block DCT, Hamming-distance matching against the public SD1/SD2/SDXL/FLUX payload bit strings). No code was copied verbatim; the algorithm and the public payload constants are what's shared. |
| [`src/provenance/novelai.ts`](src/provenance/novelai.ts) | [`NovelAI/novelai-image-metadata`](https://github.com/NovelAI/novelai-image-metadata) (stealth-alpha/RGB PNG metadata reference) | MIT | Own port using the Web `DecompressionStream` API instead of Python's `gzip`. |
| Everything else in `src/`, `entrypoints/` | — | MIT (this project) | Written for this project. |

## C2PA Trust List (bundled data, not code)

| File | Licence | Source |
|---|---|---|
| `public/provenance/C2PA-TRUST-LIST.pem`, `C2PA-TSA-TRUST-LIST.pem` | **CC BY 4.0** | [c2pa-org/conformance-public](https://github.com/c2pa-org/conformance-public/tree/main/trust-list), commit `99927caef670ca4ad9da5e5542dca39e42fad6f3` (2026-08-14), redistributed unmodified |

**Attribution** (as required by CC BY 4.0): C2PA Trust List, © Coalition for
Content Provenance and Authenticity (C2PA), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Used unmodified,
entirely locally, only to decide whether a Content Credentials signer chains
to a C2PA-conformant certificate authority. Full provenance notes:
[`public/provenance/TRUST-LIST-NOTICE.txt`](public/provenance/TRUST-LIST-NOTICE.txt).
The frozen pre-2026 "Interim Trust List" is **not** bundled — its
redistribution licence could not be confirmed — so assets signed only under
it show as "valid signature, signer not on the C2PA Trust List" rather than
"trusted."

## Models downloaded at runtime (not bundled; fetched from Hugging Face, once, with consent)

Every default is pinned to an exact Hugging Face commit in
[`src/engine/models.ts`](src/engine/models.ts), so the files can't change
under a release. "Check for updates" (Options, off by default) compares
against each repo's latest commit before ever downloading anything new.

| Model slot | Repo (pinned revision) | Task | Weights licence | Upstream model | Size (q8, WASM default) |
|---|---|---|---|---|---|
| `classifier` (Ensemble default + Classifier mode) | [`onnx-community/tmr-ai-text-detector-ONNX`](https://huggingface.co/onnx-community/tmr-ai-text-detector-ONNX) @ `b9aa251e5bcda7e429fcc936767d921435945b60` | Text classification | **MIT** | [`Oxidane/tmr-ai-text-detector`](https://huggingface.co/Oxidane/tmr-ai-text-detector) (RoBERTa-base, trained on RAID) | ~126 MB |
| `classifierLite` (Classifier-lite mode; optional ensemble classifier) | [`onnx-community/e5-small-lora-ai-generated-detector-ONNX`](https://huggingface.co/onnx-community/e5-small-lora-ai-generated-detector-ONNX) @ `02919a911bb647ceac84de99afb00ea2da8c2725` | Text classification | **MIT** | [`MayZhou/e5-small-lora-ai-generated-detector`](https://huggingface.co/MayZhou/e5-small-lora-ai-generated-detector) (LoRA on `intfloat/e5-small`, MIT; trained on RAID) | ~35 MB |
| `perplexityLM` (Ensemble default + Perplexity mode) | [`Xenova/distilgpt2`](https://huggingface.co/Xenova/distilgpt2) @ `a41c10485c18a64b6606729b6a082330cbd8f49e` | Causal LM | **Apache-2.0** | [`distilbert/distilgpt2`](https://huggingface.co/distilbert/distilgpt2) | ~85 MB |
| `binocularsObserver` (Binoculars mode, experimental) | [`onnx-community/SmolLM2-135M-ONNX`](https://huggingface.co/onnx-community/SmolLM2-135M-ONNX) @ `d0ae6834f1df45e0e95b5fdae95e536f9ca7cd3f` | Causal LM | **Apache-2.0** | [`HuggingFaceTB/SmolLM2-135M`](https://huggingface.co/HuggingFaceTB/SmolLM2-135M) | ~140 MB |
| `binocularsPerformer` (Binoculars mode, experimental) | [`onnx-community/SmolLM2-135M-Instruct-ONNX`](https://huggingface.co/onnx-community/SmolLM2-135M-Instruct-ONNX) @ `b8a5c0f183b78c55955a5364f610c36668b5e681` | Causal LM | **Apache-2.0** | [`HuggingFaceTB/SmolLM2-135M-Instruct`](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct) | ~139 MB |

Notes:

- The `onnx-community`/`Xenova` repos are ONNX format conversions and mostly
  carry no licence tag of their own; the **upstream model's licence is
  authoritative** and is what's listed above (verified against each model
  card on 2026-09-27; see `docs/feasibility.md` §8).
- **Weights are never redistributed by this project.** The extension
  downloads them directly from Hugging Face at runtime, after your explicit
  consent (see [`PRIVACY.md`](PRIVACY.md)); the npm/git package contains only
  the code and libraries listed above.
- **Custom models**: if you point a model slot at a different Hugging Face
  repo (Options → custom model), its licence is looked up and shown, with a
  warning if it isn't on an open-licence allowlist
  (`src/engine/models.ts:OPEN_LICENSES`). That model is not covered by this
  document — check its own model card.

## Training / evaluation datasets (not bundled or redistributed; referenced for transparency)

| Dataset | Licence | Role | Notes |
|---|---|---|---|
| [RAID](https://huggingface.co/datasets/liamdugan/raid) ([paper](https://arxiv.org/abs/2405.07940), [repo](https://github.com/liamdugan/raid)) | MIT | Training data for both bundled default classifiers (TMR and the lite e5-small model) | Contains outputs from several commercial LLMs (GPT-4/ChatGPT, Llama-2-chat, Mistral, Cohere, etc.); some of those vendors' terms restrict using their outputs to build *competing generative models*. A binary AI-text detector is not a generative model, and in any case those terms bind the dataset's creators, not downstream users of the MIT-licensed weights trained on it. Mentioned here for transparency, per `docs/feasibility.md` §8; it does not block this project's use. |
| [MAGE](https://huggingface.co/datasets/yaful/MAGE) ([paper](https://arxiv.org/abs/2305.13242)) | Apache-2.0 | Held-out evaluation only (`docs/calibration.md`) — **not** used to train either bundled classifier, and **not bundled**: `scripts/compare-classifiers.mjs` fetches and locally caches a sample for calibration, and that cache is git-ignored | Used to sanity-check and set the score thresholds documented in [`docs/calibration.md`](docs/calibration.md) and summarized in [`README.md`](README.md#how-accurate-is-it). |

## Full generated licence manifest

The authoritative, always-up-to-date list of what actually ships is
`public/licenses/` after a build (gitignored; regenerated every time from the
sources above by `scripts/copy-vendor-assets.mjs`) — inspect it directly with:

```sh
npm run build && ls .output/chrome-mv3/licenses/
```
