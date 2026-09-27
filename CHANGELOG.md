# Changelog

All notable changes to this project are documented here. This project has
not yet had a public store release; version numbers so far track
`package.json` during initial development.

## [Unreleased]

### Fixed (false positives on human pages)

- The automatic Quick check now uses TMR instead of the lite model, and any page it reads as
  50% or more is re-checked with Fusion before anything is shown (Options → "Confirm high
  Quick scores with Fusion", on by default). The chip shows from 70% (was 35%). On the web eval
  set, human texts shown ≥ 50% drop from 41% to 3%; AI texts shown ≥ 70% rise from 51% to 67%.
  Examples: an r/AskHistorians thread 95% → 41%, Wikipedia 82% → 34%.
- Transcript display curves are fitted on the path each caption type really takes (a human TED
  talk read 53%, now 23%); YouTube ads no longer make a captioned video read "No transcript".
- Per-comment labels, filter badges, search markers and sentence tooltips use the calibrated
  per-item curve of the detectors that ran (they used the Fusion document curve, or the raw score).

### Added (page-type routing)

- The extension now tells a text page from a thread, a video, a subtitle file, a
  search page and an app (URL rules for major sites, then a fingerprint from
  structured data, OpenGraph, the site's platform and the page's shape), and
  runs only what suits it: page text on articles and threads, transcript and
  voice on videos (a page video's `<track>` too, voice on click), timed
  scoring on subtitle files, snippet markers on search, nothing automatic on
  apps. The popup shows it quietly ("Page: video (YouTube)") with a per-site
  override; Options lists the overrides.

### Fixed

- YouTube transcripts: read through the player's own caption request (the
  bare caption URLs now return nothing, and the hidden transcript panel never
  loaded), on watch pages and Shorts. The viewer's caption settings are
  restored afterwards.
- Voice: the first score shows after two clips, with the front-loaded clip
  rate in the Quick tier too; Shorts sample the Short, not the hidden watch
  player.
- First-run checklist lists every model the defaults use (the lite model,
  Fusion, the voice model) and "Download & enable" downloads them all with
  progress.
- Transcript, search-snippet and warm-up checks no longer overwrite the tab's
  own score in the popup/badge; search markers were never shown because
  snippets fell under the 50-word minimum.

### Added (T9: Presence modes, battery saver, more entry points, chat/thread adapters, slop filter, site memory)

- **Presence**: a single setting (default **Status chip**) for how much the
  extension shows -- On click, Badge, Status chip, Inspector, or Side panel
  (Chrome `sidePanel` / Firefox `sidebar_action`) -- backed by per-site
  auto-run rules, configurable result surfaces, chip corner/auto-hide
  threshold, and a "never on this site" toggle. Auto-run uses a fast model;
  a click always runs the full configured mode.
- **Battery saver**: Battery Status API / Compute Pressure gating (where
  available), with a manual override where they're not (e.g. Firefox
  desktop), plus an idle-unload timer.
- **More entry points**: context menus for the page, an image ("Check image
  for Content Credentials & watermarks"), and text in an input/textarea/
  contenteditable box; a popup paste box and .txt/.md/.html/.docx file drop
  (local extraction, no new dependency); rebindable keyboard `commands`.
- **Chat-site and comment/thread adapters**: per-reply scoring on ChatGPT/
  Claude/Gemini/Copilot/Perplexity-like chat UIs (assistant messages only),
  and per-comment/per-post scoring on Reddit, Hacker News, forums, reviews
  and YouTube comments (previously skipped by the whole-page scan).
- **Slop filter** (off by default): dims/collapses flagged comments/posts/
  reviews with a "Show" affordance, plus a small marker on flagged
  search-result snippets (Google/Bing/DuckDuckGo/Kagi; snippet text only).
- **Site memory** (off by default, local only): a per-domain score tally,
  clearable from Options.
- Copy pass: main surfaces show a number plus one word (Human/Mixed/AI/Too
  short), with per-detector numbers, device, model versions and one fixed
  "probability, not proof" note behind a single Details disclosure.

### Known gaps (see docs/qa.md's T9 addendum)

Chat/Reddit/search-engine selectors weren't verified against live sites (no
network access); the Chrome/Firefox E2E suites and docs/screenshots weren't
extended/re-taken for the new UI; the toolbar badge isn't yet gated by
`Settings.surfaces.badge`; `useCpuOnBattery` has no per-request engine
channel yet.

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
