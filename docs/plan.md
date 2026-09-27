# Implementation plan

Free, open-source (MIT), fully local AI-content detector for Chrome and Firefox (MV3).
The research behind it is in [feasibility.md](feasibility.md) and [watermarks.md](watermarks.md).
Accuracy is **not** the goal. The goals are open licences, privacy, and honest UI.

## Decisions (from the user)
- Everything runs locally, with no APIs, keys or cost. Models download once from Hugging Face.
- **Detector mode is a setting:** Ensemble (default), Classifier, Classifier-lite, Perplexity,
  Binoculars (experimental).
- **Highlight style is a setting:** Heatmap (default), Flagged-only (Ctrl+F style), Underline.
- A hidden-Unicode scan always runs (`src/detectors/unicode.ts`, already done).
- **Provenance and watermarks (T4, per watermarks.md):** C2PA / Content Credentials via
  `@contentauth/c2pa-web` (running in the offscreen doc / worker, with a bundled C2PA Trust List,
  CC-BY-4.0 attribution, no remote fetching). IPTC DigitalSourceType and generator metadata
  (ExifReader plus our own PNG chunk parser), labelled "unsigned claim". SD/SDXL/FLUX
  invisible-watermark DWT-DCT decoder (our own MIT JS): a hit is a positive, a miss means nothing.
  NovelAI alpha metadata. C2PA text manifests via `c2pa-text`.
  **Always shown as "cannot be checked locally":** SynthID (Google, and OpenAI images and audio),
  Claude text watermark (Aug 2026, keyed), Gemini text, Meta Content Seal, Digimarc, TrustMark.
  The UI must say "no watermark found ≠ human-made".
- A floating in-page pill shows progress, then the score, with ▲/▼ to step through flagged
  sentences and ✕ to clear. The toolbar badge shows a spinner, then the %.
- Packaging: store-ready Chrome zip, Firefox zip, AMO sources zip. **No publishing or signing
  by the agent.** The user runs those commands.
- **Models are updatable.** Each release ships pinned, known-good revisions. Settings has
  "Check for updates", which queries the HF API for each repo's latest commit and shows the new
  revision and its licence. Updating is one click: the new revision downloads, the old one is kept
  until the new one loads, and rollback stays available. An auto-check toggle defaults to off.
  **Custom models:** a user-entered HF repo ID per mode (classifier or causal LM), validated for
  ONNX files and task, with its licence shown and a warning for non-open or gated licences.
- Subagent models: Opus for ML and provenance, Sonnet for scaffold, UI and packaging.

## Architecture
```
content script (extract text → sentences; render highlights, pill, tooltips, image badges)
   │  runtime messages (src/shared/messages.ts)
   ▼
background (Chrome: service worker, Firefox: event page) — router, badge, settings
   │
   ▼
inference host (Chrome: offscreen document, Firefox: dedicated Worker from event page)
   transformers.js 4.x + bundled ORT wasm (public/ort/, wasmPaths set, never CDN)
   WebGPU if available, else WASM (Chrome multithreaded via COEP/COOP, Firefox 1 thread)
popup: gauge, mode, style, run button, download consent + progress
options: all settings, model cache management, About + licences
```
Default models are pinned by repo revision in `src/engine/models.ts`. The active
`{repo, revision}` per model slot comes from settings (`modelOverrides`), so updates and custom
models need no code change. They are cached through the Cache
API, with an IndexedDB fallback.

## Shared contract (written in T0, and other tasks must not change it without the lead)
`src/shared/messages.ts` and `src/shared/settings.ts`:
- `TextBlock { id: string; text: string; sentences: {start:number; end:number}[] }`
- `AnalyzeRequest { tabId; mode; blocks: TextBlock[] }`
- `SentenceScore { blockId; index; score: number /*0..1 AI*/; sources: Partial<Record<'classifier'|'perplexity'|'binoculars', number>> }`
- Progress events `{ phase:'download'|'load'|'analyze', loaded, total, message }`
- `AnalyzeResult { overall: number; sentences: SentenceScore[]; unicode: UnicodeScanResult; tooLong?: boolean; notes: string[] }`
- `Settings { mode; highlightStyle; autoRun: boolean; minWords: number; maxTokens: number; showUnicode: boolean; checkImages: boolean; consentedDownload: boolean; autoCheckModelUpdates: boolean; modelOverrides: Record<ModelSlot, {repo:string; revision:string; previous?: {repo:string; revision:string}}> }`
- `ModelSlot = 'classifier'|'classifierLite'|'perplexityLM'|'binocularsObserver'|'binocularsPerformer'`
- Model-management messages: `checkModelUpdates`, `updateModel(slot)`, `rollbackModel(slot)`, `setCustomModel(slot, repo)`, `deleteCachedModel(slot)`

## Tasks
| # | Task | Owner model | Depends on | Owns paths |
|---|---|---|---|---|
| T0 | WXT scaffold, manifest (both browsers), CSP, COEP/COOP, ORT copy step, shared types, settings store, vitest (port unicode test), all deps preinstalled | Sonnet | – | package.json, wxt.config.ts, src/shared/**, entrypoint stubs, public/ort |
| T1 | Inference engine: host per browser, model registry, classifier / perplexity / binoculars / ensemble, chunking, sentence mapping, progress, cache fallback, device selection, model update/rollback/custom-model/validation backend | Opus | T0 | src/engine/**, entrypoints/offscreen*, inference worker |
| T2 | Content script: visible-text extraction, sentence segmentation, 3 highlight styles, Unicode markers, floating pill + navigation, tooltips (Shadow DOM, no page CSS leakage) | Sonnet | T0 | entrypoints/content/**, src/content/** |
| T3 | Popup + options UI: gauge, mode/style selects, consent + download progress, model management (check updates, update, rollback, custom model with licence display, cache size/delete), About/licences, badge updates in background | Sonnet | T0 | entrypoints/popup/**, entrypoints/options/**, src/ui/** |
| T4 | Provenance and watermarks: image metadata/C2PA/etc. per watermarks.md, image badges | Opus | T0, research | src/provenance/** |
| T5 | Integration + QA: wire it all together, run in real Chrome and Firefox, fix bugs, sanity-calibrate thresholds on a small sample | Opus | T1–T4 | cross-cutting |
| T6 | Packaging + docs: `npm run package` → chrome zip, firefox zip, sources zip; icons; README (honest accuracy section), PRIVACY.md, THIRD_PARTY.md, LICENSE (MIT), store listing text, load/sign instructions | Sonnet | T5 | root docs, scripts/ |

T1–T4 run in parallel after T0. Each task commits only its own paths locally and never pushes.
Only T0 edits package.json. Later tasks ask the lead if they need a dependency.

## T7: Fusion mode (added at the user's request, ships in v0.1.0)
A detector mode `fusion` where the user chooses any subset of detectors (classifier/TMR,
classifierLite/e5, ModernBERT RAID+MAGE detector (Apache-2.0, new slot), perplexity, binoculars)
and a fusion method: calibrated weighted average (default, weights fitted on calibration data),
log-odds average, majority vote, or max. Per-sentence and overall agreement ("n/m detectors agree",
"detectors disagree, low confidence") appears in the popup, tooltips and pill. Settings show the
total download size and a speed estimate for the chosen set. Calibrate on the browser runtime
like T5 did, and add unit tests and E2E coverage. Update README, THIRD_PARTY, store listing,
calibration.md and qa.md. Owner model: Opus. Runs after T5 (same files).

## T8: Battery saver (added at the user's request, ships in v0.1.0)
Browsers don't expose OS low-power mode (macOS Low Power Mode / Windows battery saver), so use
the available signals: Battery Status API (Chrome: charging, level; verify Firefox
availability), and Compute Pressure API (Chrome, where available). Settings (defaults in
brackets):
- on battery: [normal] | use lite model | pause auto-run (manual only)
- below N% battery [20%]: pause analysis, with a "Paused to save battery, run anyway?" prompt
  in the pill and popup
- pause under serious/critical CPU pressure [on]
- unload models after N minutes idle [5]
- manual "battery saver" toggle, shown prominently where the battery API is unavailable
  (Firefox)
Owner model: Sonnet. Owns src/power/**. Makes additive edits to settings, the background gate
before analysis, and the popup/options sections. Runs alongside T7 (T7 owns engine, fusion and
calibration).

## Out of scope for v1
Remote APIs (incl. Anthropic's planned watermark-detection API and SynthID), VideoSeal/AudioSeal/TrustMark (35–228 MB models, v2), non-English calibration, and store publishing
(done by the user).
