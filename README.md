<div align="center">

# Local AI Detector

**Filter AI-generated content. Runs on your device.**
Free, open-source, fully local AI-content detector for Chrome and Firefox.
No servers, no API keys, no accounts, no telemetry. Every analysis — text
classification, perplexity, hidden-Unicode scanning, and image provenance
(C2PA / watermarks) — runs on-device, in the browser, using models you
download once from Hugging Face.

[Install](#install) · [Features](#features) · [How accurate is it?](#how-accurate-is-it) · [Privacy](#privacy) · [Build from source](#build-from-source) · [Contributing](#contributing) · [Licence](#licence)

</div>

## What it is

Local AI Detector adds a small pill to the page you're reading and a button
in the toolbar. Click it (or let it run automatically) and it:

- scores the visible text for AI-generated writing patterns, sentence by
  sentence, using an on-device classifier and/or a perplexity model;
- highlights the flagged sentences directly on the page;
- flags hidden/invisible Unicode characters in the text;
- checks images on the page for C2PA Content Credentials, generator
  metadata, and known open-source invisible watermarks.

Nothing leaves your machine except the one-time model download from Hugging
Face and, if you opt in per site, the bytes of an image you ask it to check.
See [Privacy](#privacy) for the exact, complete list of network requests.

|  |  |
|---|---|
| ![Popup result](docs/screenshots/popup-result.png) | ![Heatmap highlight style](docs/screenshots/page-heatmap.jpg) |
| Popup: gauge, verdict, per-detector breakdown | Heatmap highlight style on the page |
| ![Pill navigation](docs/screenshots/page-pill-nav.jpg) | ![Image provenance badges](docs/screenshots/page-image-badges.jpg) |
| The in-page pill: ▲/▼ steps through flagged sentences | C2PA badge on an image with Content Credentials |
| ![Options](docs/screenshots/options.jpg) | ![Consent screen](docs/screenshots/popup-consent.png) |
| Options: models, engine info, cache management | First-run consent before any download |

(More screenshots, including Firefox, are in [`docs/screenshots/`](docs/screenshots/).)

## Features

### Presence (Options → Presence)

How much the extension shows, by default **Status chip**: a small corner
label that stays quiet (hidden below a threshold, peekable on hover) and
expands into the full inspector on click. Other presets: **On click**
(nothing until you ask), **Badge** (toolbar % only), **Inspector** (today's
always-on highlights + pill), **Side panel** (Chrome `sidePanel` / Firefox
sidebar — a full report, click a flagged sentence to scroll to it, never
marks the page). Auto-run uses a fast model; the full mode you've configured
always runs on demand. Per-site rules ("never on this site") and a
battery-saver (Battery Status API / Compute Pressure where available, a
manual toggle where they're not) live in the same section.

### More entry points

Context menus to analyze the page, check an image for Content Credentials &
watermarks, or check the text in an input/textarea/contenteditable box; a
popup paste box and file drop (.txt/.md/.html/.docx, extracted locally); and
rebindable keyboard shortcuts (analyze page/selection, toggle visibility).

### Chat and thread adapters (`src/content/adapters/`)

On ChatGPT, Claude, Gemini, Copilot, Perplexity and similar chat UIs, only
assistant replies are scored (never your own prompt). On Reddit, Hacker
News, forums, reviews and YouTube comments, each comment/post/reply gets its
own score instead of being skipped by the normal page scan. An optional
**slop filter** (off by default) dims or collapses items above a threshold,
with a "Show" button on each, plus a small marker on flagged search-result
snippets on Google/Bing/DuckDuckGo/Kagi (the snippet text only — it never
fetches the linked page). An optional, local-only **site memory** keeps a
per-domain tally ("7 of the last 10 pages scored high"); no page text or URLs
are ever stored, and it's fully clearable from Options.

### Detector modes (Options → Mode)

| Mode | What it runs | Notes |
|---|---|---|
| **Fusion** (default; was "Ensemble") | Any mix of the detectors below, combined by weighted average (default), log-odds average, majority vote or max. Default set: **Fakespot + TMR** | Every result says how many detectors agree, and flags it when they split. Options → Fusion shows the download size and speed of your mix |
| **Classifier** | [`tmr-ai-text-detector`](https://huggingface.co/onnx-community/tmr-ai-text-detector-ONNX) (RoBERTa-base, RAID-trained, MIT) | ~250 MB (fp16, GPU) / ~130 MB (q8, CPU) |
| **Classifier-lite** | [`e5-small-lora-ai-generated-detector`](https://huggingface.co/onnx-community/e5-small-lora-ai-generated-detector-ONNX) (MIT) | The quick automatic pass; ~35–70 MB, noticeably weaker |
| **Perplexity** | [`distilgpt2`](https://huggingface.co/Xenova/distilgpt2), lower perplexity ⇒ more AI-like | Classic GPTZero-style signal; weak on its own |
| **Binoculars** *(experimental)* | Two [`SmolLM2-135M`](https://huggingface.co/onnx-community/SmolLM2-135M-ONNX) models (base + instruct) | Cross-perplexity ratio; slow, CPU-only |

Fusion-only detectors: **Fakespot** ([`fakespot-ai/roberta-base-ai-text-detection-v1`](https://huggingface.co/fakespot-ai/roberta-base-ai-text-detection-v1),
Mozilla's RoBERTa detector, Apache-2.0, ~130 MB, CPU) — the best single detector on our web
test set — and **ModernBERT** ([RAID + MAGE](https://huggingface.co/onnx-community/modernbert-ai-detection-raid-mage-ONNX),
Apache-2.0, ~155 MB, CPU; weaker on today's models).

Runs on the GPU (WebGPU) by default, with a CPU (WASM) fallback that has its own
calibration. Fakespot, ModernBERT and Binoculars always use the CPU.

A hidden-Unicode scan (zero-width characters, tag characters, bidi controls,
etc.) always runs alongside whichever mode is selected, and is shown
separately as "unusual invisible characters" — **never** folded into the AI
score, since ordinary typography, CJK input methods, and copy-pasting from
Word or PDFs produce these too.

### Highlight styles (Options → Highlight style)

- **Heatmap** (default): every sentence is tinted by its own score.
- **Flagged-only**: only sentences at or above the flagged threshold are
  marked (Ctrl+F-style).
- **Underline**: a subtler wavy underline instead of a background tint.

All three use the CSS Custom Highlight API (no DOM mutation of the page's
text), with a `<mark>`-based fallback where it isn't available.

### Provenance and watermarks (images)

Every image the extension is allowed to check ([permission model](#privacy))
is run through, in order:

1. **C2PA / Content Credentials** — cryptographic signature and hash
   validation via [`@contentauth/c2pa-web`](https://github.com/contentauth/c2pa-js),
   with the signer checked against a bundled [C2PA Trust List](https://github.com/c2pa-org/conformance-public)
   (CC BY 4.0, attributed in [`THIRD_PARTY.md`](THIRD_PARTY.md)). No OCSP or
   remote manifest fetching — everything is checked offline.
2. **Unsigned generator metadata** — IPTC `DigitalSourceType`, Stable
   Diffusion WebUI/ComfyUI/InvokeAI parameters, NovelAI's stealth-alpha PNG
   metadata, Midjourney/China GB 45438-2025 labels, read with
   [ExifReader](https://github.com/mattiasw/ExifReader) plus a small PNG-chunk
   parser. Always labelled **"unsigned claim"**: plain text, trivially forged
   or stripped.
3. **Stable Diffusion / SDXL / FLUX invisible watermark** — our own
   from-scratch port of the `imwatermark` DWT-DCT decoder (a hit is a
   positive; a miss means nothing, since it doesn't survive resizing,
   cropping or rotation).
4. **Text: C2PA text manifests** — via [`c2pa-text`](https://github.com/encypherai/c2pa-text).

**Always shown as "cannot be checked locally"** (no key, no bundleable
detector, or a proprietary/rate-limited portal is the only checker):

- **Google SynthID** (image, video, audio, text) — also used by OpenAI
  (images/audio) and ElevenLabs (audio).
- **Anthropic's Claude text watermark** (SynthID-Text-style, keyed;
  detector is private preview only).
- **Gemini's text watermark** (SynthID-Text, Google's own key).
- **Meta Content Seal** (Muse Image).
- **Digimarc**, and **Adobe TrustMark**'s ID → manifest lookup (the ID
  decode is local, but resolving it to a verdict needs Adobe's remote API).
- Any keyed academic LLM watermark (Kirchenbauer/Aaronson-style) whose key
  isn't public.

The UI is explicit everywhere: **"no watermark found" is never shown as
"human-made"** — it means exactly what it says, nothing more. See
[`docs/watermarks.md`](docs/watermarks.md) for the full research and
per-provider survey behind this list.

### Model updates

Default models are pinned to an exact Hugging Face commit per release
(`src/engine/models.ts`). Options → "Check for updates" queries the HF API
for each model's latest commit and shows the new revision and its licence
before you update; the previous revision is kept until the new one loads
successfully, and rollback is one click. Auto-checking is **off by default**.
You can also point any model slot at a custom Hugging Face repo; its licence
is looked up and shown, with a warning for anything not on an open-licence
allowlist.

## How accurate is it?

**Short version: good at catching unedited, straight-out-of-the-box AI filler; easy
to fool on purpose; and tuned so it would rather let slop through than hide a real
person.** It isn't a forensic tool, and a score isn't proof.

The number you see ("AI 91%") is a **calibrated probability**. On our web test set,
about 91 of every 100 texts shown at 91% really were AI-generated. That assumes equal amounts of human and AI text. Where AI text is rarer, the real odds are lower.
Under 30 words there's too little text to say anything, so you'll see "—".

Measured in the extension itself, on the held-out half of about 1,900 web texts: Reddit
posts, Q&A answers, Amazon/Trustpilot reviews, news, how-to articles, short social posts,
stories and essays. The AI side comes from 2024–26 models (GPT-4o/4.1, o3, Gemini 2.x, Claude,
DeepSeek, Qwen, Llama, Mistral, …); the human side comes from the same sites. Full numbers are in
[`docs/calibration.md`](docs/calibration.md).

| | Tells AI from human (AUROC) | Human texts flagged | AI texts flagged | Slop filter: hidden items that were AI / AI caught |
|---|---|---|---|---|
| **Fusion (default: Fakespot + TMR)** | **0.91** | **5%** | **68%** | **99%** / 54% |
| Lite (automatic quick pass) | 0.77 | 6% | 39% | 97% / 22% |

| Genre (default Fusion, AUROC) | Reviews | News | Stories | Essays | Social | Blog / how-to | Answers | Forum posts |
|---|---|---|---|---|---|---|---|---|
| | 0.98 | 0.92 | 0.94 | 0.93 | 0.94 | 0.90 | 0.87 | 0.81 |

An unedited assistant-voice story ("write me a short story about…") now shows about
**AI 95%**, against the "51%" someone reported on the old scale. Stories from OpenAI's own models were the
hardest group in the test set (a small sample: about 60% shown on average).

Known, deliberate weaknesses:

- **Paraphrasing and "humanizer" tools beat it**, as they beat every public
  detector ([RAID](https://arxiv.org/abs/2405.07940)). So does a person editing the text.
- **Forum posts are the hardest genre.** Casual Reddit-style AI posts slip through more
  often than reviews or news.
- **Non-native English writing** scores higher on detectors like these (a well-known bias).
  English only.
- **Short text is noisy.** Comments under about 50 words get wider error bars, and single
  sentences are always scored together with their neighbours.
- Binoculars is experimental.

## Privacy

See [`PRIVACY.md`](PRIVACY.md) for the complete, precise list of every
network request the extension makes and when. In short: no analytics, no
accounts, no servers of ours — the only network access is downloading/
updating models from `huggingface.co`/`*.hf.co`, and fetching an image's
bytes only for a site you've explicitly allowed.

## Install

### From source (Chrome, Firefox, Edge, Brave — any Chromium or Gecko browser)

There is no published listing yet (see [`docs/release.md`](docs/release.md)
for the maintainer's publishing checklist). Until then, build and load it
yourself — see [`docs/install.md`](docs/install.md) for full details,
screenshots, and troubleshooting. Quick version:

```sh
git clone https://github.com/freddygaffey/ai_detector.git local-ai-detector
cd local-ai-detector
npm ci
npm run build            # -> .output/chrome-mv3
npm run build:firefox    # -> .output/firefox-mv3
```

**Chrome / Edge / Brave:** open `chrome://extensions`, enable *Developer
mode*, click *Load unpacked*, and select `.output/chrome-mv3`.

**Firefox:** open `about:debugging#/runtime/this-firefox`, click *Load
Temporary Add-on…*, and select any file inside `.output/firefox-mv3` (e.g.
`manifest.json`). Temporary add-ons are removed when Firefox restarts; see
[`docs/install.md`](docs/install.md) for how to load it permanently.

## Build from source

```sh
npm ci                  # installs deps; postinstall copies vendored WASM/licences
npm run dev              # Chrome, dev mode with HMR
npm run dev:firefox      # Firefox, dev mode
npm run build             # Chrome production build -> .output/chrome-mv3
npm run build:firefox     # Firefox production build -> .output/firefox-mv3
npm test                  # vitest (223+ unit tests)
npm run typecheck
npm run package            # full release build: typecheck, tests, both browsers,
                            # web-ext lint, chrome/firefox/sources zips, sha256,
                            # rebuild-determinism check -> release/
```

Node and npm versions are pinned in [`.nvmrc`](.nvmrc) and
`engines` in [`package.json`](package.json). See
[`BUILD_FROM_SOURCE.md`](BUILD_FROM_SOURCE.md) for the exact reproducible
build a reviewer (or you) would run from a release's source zip.

## Architecture

```
content script (extract visible text → sentences; render highlights, the
                floating pill, tooltips, image badges — Shadow DOM, no page
                CSS leakage)
   │  runtime messages (src/shared/messages.ts)
   ▼
background (Chrome: service worker · Firefox: event page)
   — routes messages, owns the toolbar badge and settings, orchestrates the
     one analysis path shared by the popup, the pill, and the context menu
   │
   ▼
inference host  (Chrome: an offscreen document · Firefox: a dedicated Worker
                 spawned from the event page)
   transformers.js 4.x + bundled onnxruntime-web WASM (public/ort/, wasmPaths
   pinned, never a CDN) — WebGPU by default, WASM fallback
                 also hosts C2PA validation (@contentauth/c2pa-web, its own
                 packaged worker/WASM under public/c2pa/)

popup: gauge, mode/style pickers, download consent + progress, per-site image
       permission button
options: all settings, model cache management (check/update/rollback/custom
         model + licence display), About/licences, WebGPU toggle
```

Every default model is pinned to an exact Hugging Face commit in
[`src/engine/models.ts`](src/engine/models.ts); the active `{repo, revision}`
per model slot comes from settings, so "Check for updates" and custom models
need no code change. Models are cached with the Cache API (IndexedDB
fallback). Full design rationale: [`docs/plan.md`](docs/plan.md) and
[`docs/feasibility.md`](docs/feasibility.md).

## Contributing

This is a small, honest side project, not a maintained product with SLAs —
but issues and pull requests are welcome, especially:

- calibration data (more languages, more generators, more genres of human
  writing — see [`docs/calibration.md`](docs/calibration.md) for the method);
- additional openly-licensed provenance/watermark schemes
  ([`docs/watermarks.md`](docs/watermarks.md) has the survey and the
  licence/feasibility bar new schemes need to clear);
- bug reports with a URL or a minimal reproduction, ideally with the
  Options → "engine info" line and browser/OS.

Before sending a PR: `npm run typecheck && npm test && npm run build &&
npm run build:firefox` should all pass, and `npm run package` should
succeed end-to-end if you're touching anything packaging-related. There's no
CI configured (see [`docs/release.md`](docs/release.md)), so please run
these locally.

## Licence

MIT — see [`LICENSE`](LICENSE). Third-party libraries, runtime-downloaded
models, and their licences are listed in full in
[`THIRD_PARTY.md`](THIRD_PARTY.md).
