# Changelog

All notable changes to this project are documented here. This project has
not yet had a public store release; version numbers so far track
`package.json` during initial development.

## [0.1.0] — 2026-09-27

First feature-complete release, built and tested end-to-end in real Chrome
and Firefox (see [`docs/qa.md`](docs/qa.md) for the full test report).

### Added

- **Detector modes**: Ensemble (default: classifier + perplexity), Classifier
  (TMR RoBERTa-base, RAID-trained), Classifier-lite (e5-small LoRA),
  Perplexity (DistilGPT-2), and Binoculars (experimental; two SmolLM2-135M
  models). All run fully on-device via `@huggingface/transformers` +
  `onnxruntime-web` (WASM by default, WebGPU opt-in).
- **Highlight styles**: Heatmap, Flagged-only, and Underline, rendered with
  the CSS Custom Highlight API (with a `<mark>`-based fallback).
- **Hidden-Unicode scan**: always-on detection of zero-width characters, tag
  characters, and bidi controls, reported separately from the AI score and
  labelled "unusual characters," never "AI watermark."
- **Provenance and watermarks for images**: C2PA / Content Credentials
  validation against a bundled Trust List (CC BY 4.0), unsigned generator
  metadata (IPTC `DigitalSourceType`, SD WebUI/ComfyUI/InvokeAI/NovelAI/
  Midjourney/GB 45438-2025 tags), a from-scratch Stable Diffusion/SDXL/FLUX
  invisible-watermark (DWT-DCT) decoder, and C2PA text-manifest detection.
  A static panel lists schemes that **cannot** be checked locally (Google
  SynthID, Anthropic's and Gemini's text watermarks, Meta Content Seal,
  Digimarc, TrustMark's remote resolution), with user-initiated external
  checker links only.
- **Model updates**: pinned default model revisions per release; Options →
  "Check for updates" queries the Hugging Face API, shows the new revision
  and licence, and updates with one click, keeping the previous revision
  available for rollback. Auto-check is off by default. Custom
  Hugging-Face-repo models are supported per slot, with licence lookup and a
  warning for non-open licences.
- **UI**: a floating in-page pill (progress → score → ▲/▼ sentence
  navigation → ✕ to clear), a toolbar badge, a popup (gauge, verdict,
  per-detector breakdown, download consent, per-site image-permission
  button), and an options page (all settings, model cache management,
  About/licences).
- **Packaging**: `npm run package` builds, tests, lints, and zips
  store-ready Chrome and Firefox packages plus an AMO source-code
  submission, with SHA-256 checksums and a rebuild-determinism check. See
  [`docs/release.md`](docs/release.md).
- Full documentation: honest accuracy section and feature overview in
  [`README.md`](README.md), exact network-request accounting in
  [`PRIVACY.md`](PRIVACY.md), full licence/attribution list in
  [`THIRD_PARTY.md`](THIRD_PARTY.md), install guides for end users and
  developers in [`docs/install.md`](docs/install.md), a step-by-step
  publishing guide in [`docs/release.md`](docs/release.md), and Chrome Web
  Store/AMO listing text under [`store/`](store/).

### Known limitations (see [`docs/calibration.md`](docs/calibration.md) and [`docs/qa.md`](docs/qa.md) for detail)

- The default ensemble catches roughly half of AI-generated text in a
  595-text held-out benchmark (MAGE), by design favouring a low
  false-positive rate over catching everything; paraphrased or humanised AI
  text will mostly pass.
- Binoculars mode is experimental and the least-tested detector.
- WebGPU (opt-in) uses different quantized weights than the default WASM
  path and isn't calibrated as thoroughly.
- Calibration data is small (49 hand-picked texts plus 595 MAGE texts),
  English-only, and not a substitute for a real benchmark.
