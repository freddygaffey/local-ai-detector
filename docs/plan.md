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

## T7b: Accuracy pass (merged into T7; user feedback: a raw ChatGPT story scored only 51%)
- Eval set of modern LLM output (GPT-5-class, Claude, Gemini style) across genres: stories and
  creative writing, chat answers, essays, emails. Plus matched human text (public domain or
  permissively licensed). Record where each item comes from and its licence.
- Evaluate candidate open-licensed detectors that ship ONNX or can be converted:
  - current: tmr, e5-lite, ModernBERT raid-mage
  - Mozilla/Fakespot `fakespot-ai/roberta-base-ai-text-detection-v1` (check the licence)
  - other recent RAID/MAGE/M4-trained detectors
  - plus perplexity and binoculars
  Pick the defaults and the fusion set by per-genre results.
- Re-calibrate on the browser runtime. The displayed score must be meaningful, so show a band
  and wording instead of a bare "confidence". Target: unedited ChatGPT/Claude stories clearly
  flagged, with a low human FPR. Report honest per-genre numbers.
- **WebGPU on by default (user decision).** `useWebGPU` defaults to true. The WebGPU
  calibration becomes the primary one (browser-fitted, with the same rigour as the CPU one),
  and CPU constants stay for the fallback (Firefox on Linux, no adapter, no shader-f16). Pick
  the weights per model on WebGPU: use fp16 or fp32 wherever q4f16 is materially worse
  (q4f16 broke Binoculars), and accept larger downloads if needed. Binoculars stays CPU unless
  a WebGPU dtype is verified correct. Record the device used in AnalyzeResult so the UI can
  show it. Update the setting's help text, calibration.md, qa.md, README and PRIVACY (no change
  expected).
- Owner: T7 (Opus).

## T8: Battery saver (merged into T9 below)
Browsers don't expose OS low-power mode (macOS Low Power Mode / Windows battery saver), so use
the available signals: Battery Status API (Chrome: charging, level; verify Firefox
availability), and Compute Pressure API (Chrome, where available). Settings (defaults in
brackets):
- on battery: [normal] | use lite model | pause auto-run (manual only)
- below N% battery [20%]: pause analysis, with a "Paused to save battery, run anyway?" prompt
  in the pill and popup
- pause under serious/critical CPU pressure [on]
- unload models after N minutes idle [5]
- use CPU instead of GPU when on battery [off]
- show the device used (GPU/CPU) in the popup detail view
- manual "battery saver" toggle, shown prominently where the battery API is unavailable
  (Firefox)
Implemented as part of T9.

## T9: Presence modes + battery saver (user feedback: the current UI is too intrusive for many users)
The engine stays as is. The UI becomes configurable around a **Presence** preset (default **On click**):
- **On click**: nothing on the page. The popup shows results, and "Show on page" turns on
  highlights and the pill for that visit.
- **Badge**: only the toolbar badge %.
- **Status chip**: a tiny corner chip ("AI 23%") that expands into the full inspector and
  collapses again. It has an optional auto-hide below a score threshold.
- **Inspector**: today's highlights plus the pill.
- **Side panel**: Chrome `sidePanel` and Firefox `sidebar_action`. A full report listing flagged
  sentences; clicking one scrolls to it. No page marking.
Underlying settings (the preset maps onto them, and "Custom" appears when edited): auto-run
policy with per-site rules (always / never / ask); result surfaces (popup, badge, chip,
highlights, side panel); chip corner; auto-hide threshold; a keyboard command to toggle
visibility; "never on this site".
Plus the battery saver from T8.
**More entry points** (the existing right-click "Check selected text" stays):
- Context menus: "Analyze this page" (page context); "Check image for Content Credentials &
  watermarks" (image context, requesting per-origin permission if needed); "Check text in this
  box" (editable context: input, textarea, contenteditable).
- Popup "Paste text": analyse arbitrary pasted text. The Unicode scan runs with
  `includeNbsp: true`.
- Popup file drop: .txt, .md, .html and .docx (text extraction must be local and have a small
  footprint; add no heavy dependency without checking with the lead). PDF is out of scope for v1.
- `commands` keyboard shortcuts: analyze page, analyze selection, toggle visibility (user-
  rebindable).
- Deliberately excluded: "analyze linked page" (it would fetch pages the user hasn't opened).
  Google Docs' canvas rendering is a known gap, so document "select + right-click" instead.
**Chat-site adapters** (src/content/adapters/): on chatgpt.com, claude.ai, gemini.google.com,
copilot.microsoft.com, perplexity.ai and similar sites, analyse only assistant messages (never
the user's prompt, the sidebar or UI chrome), with a per-reply score. There is a generic fallback
that excludes nav, aside, buttons, forms and short UI strings. Result wording shows a band plus
an explanation of detector disagreement, never a bare "51% confidence". Owner model: Sonnet. Owns entrypoints/popup, entrypoints/options
(layout), entrypoints/content, src/content, src/ui, src/power, and a new sidepanel entrypoint.
Runs alongside T7. T7 exposes its fusion settings as a self-contained options module and adds
agreement data to results; T9 mounts and displays them.

## Target user (user decision, overrides earlier defaults)
**Slightly technical readers who are against low-effort AI slop overtaking the web (not against AI itself) and want to cut it from everyday reading**. **UI is clean and minimal, not hand-holdy** (user decision, final): labels and numbers such as 'AI 91%', and one-word states (AI / Mixed / Human / Too short). There is no 'slop' wording and there are no caveats on main surfaces; a single small ⓘ/Details holds the one-line 'probability, not proof' note and the technical detail. Hostility to AI content shows in behaviour (auto-run chip, filter), not words. Tagline: 'Filter AI-generated content. Runs on your device.': articles,
Reddit, HN, forums, reviews, YouTube comments, search results. Essay checkers (students,
teachers) are secondary, because ZeroGPT/GPTZero already serve them for free. Consequences:
- Default Presence is the Status chip with auto-run on, using classifierLite; clicking runs the
  full Fusion.
- A slop filter (off by default, offered prominently) dims or collapses likely-AI comments,
  posts and reviews, with "show anyway"; search-result markers use snippet text only.
- Site memory is optional and local (domain + score + date).
- Calibration is weighted to web genres and short texts, and optimised for precision, with a
  stricter filterThreshold.
- Copy is terse and technical, and Details may show raw numbers.
- README and store lead with "Free, private AI-slop filter. Runs on your device."

## Design personas (primary: 4 and 5; the others secondary; walkthroughs run after T7/T9)
1. **High-school English teacher**: checks a stack of student essays. Time-poor, and terrified
   of falsely accusing a student. Wants a clear, defensible, non-accusatory summary.
2. **Non-native-English university student**: checks their own essay before submitting. Anxious,
   because detectors are known to over-flag non-native writers. Needs reassurance, an
   explanation of why something was flagged, and a paste box.
3. **Journalist or fact-checker**: verifies images and quotes on deadline. Wants provenance
   evidence they can cite, and speed.
4. **Casual reader tired of AI slop** (Reddit, blogs, reviews): wants zero friction and a
   glanceable signal, and hates anything covering the page.
5. **Privacy-minded developer**: reads permissions and network requests, and uninstalls on any
   phoning home. Wants power-user settings and transparency.
6. **Older, less technical user**: was forwarded a suspicious email or article. Easily
   overwhelmed; needs plain words and a single clear answer.
UI copy rules: minimal labels and numbers, jargon only inside Details, no hand-holding, and no repeated caveats.

## UX walkthroughs (after T7 + T9, before final package)
**One Sonnet agent plays all six personas in a single rough, cheap pass** (user request). It
does a quick walkthrough per persona, a few screenshots in total, one combined findings list
(severity + fix), and one consolidated copy audit with rewrites, using
docs/ux/persona-walkthrough-brief.md as a guide, not a checklist. A fix pass follows before
the final package.

## Design principles (the user's words)
**Honest, well designed, minimal, in the background and unobtrusive.**

## Display rules (approved)
- Every displayed % comes from `toDisplayProbability()`, a calibrated probability on web text.
- Threads and comment pages show a count in the chip ("3 AI") plus per-item %. Articles show a
  single %.
- Below `MIN_WORDS_FOR_SCORE` the UI shows "—".
- The chip is fully hidden below the display threshold.

## Phase 2: T10 YouTube transcripts (planned after release)
Read the transcript from YouTube's own transcript panel, falling back to the player's caption
track (same-origin youtube.com, nothing new leaves the device). The chip reads
"Transcript: AI 84%", and clicking a flagged segment seeks the video. Also surface YouTube's
"Altered or synthetic content" disclosure label. Needs its own calibration for unpunctuated
auto-captions (or punctuation restoration). It detects AI-written scripts, not synthetic
voices. Supports Shorts. Owner: Opus.

## Phase 2: T11 AI voice detection (experimental, gated on a research spike)
Spike (Opus) first:
- Find licence-clean open audio-deepfake detectors (wav2vec2/AASIST-style trained on ASVspoof,
  In-the-Wild, MLAAD or similar) with ONNX export.
- Include AudioSeal (MIT) for its own watermark.
- Test on real clips: modern TTS such as ElevenLabs, OpenAI and open TTS, against human speech,
  both after YouTube-like compression and with music or noise.
- Verdict: ship / ship as experimental / drop.

If it goes ahead:
- On click only, never auto-run.
- Capture audio via video.captureStream (Firefox: mozCaptureStream) or tabCapture, which shows
  the browser's indicator.
- Chunk and resample to 16 kHz, and run in the offscreen doc or worker.
- Show "Voice: AI 72%" beside the transcript score.
- SynthID audio and ElevenLabs' classifier are not checkable locally.

## Phases and release (user decision)
There is no v0.1 store release. **The first public release is v0.2.0.**
- **Phase 1 (foundations):** T7 and T9. The cheap persona pass feeds T9. Then T12: freeze and
  version the message contract (`contractVersion` in AnalyzeResult), and write the docs/ui-dev.md handover.
- **Phase 2:** the user iterates on UI and workflow. T10 YouTube transcripts; the T11 voice spike
  and maybe the feature; an optional thorough persona pass; final QA, then package v0.2.0, and
  the user publishes.

## Out of scope for v1
Remote APIs (incl. Anthropic's planned watermark-detection API and SynthID), VideoSeal/AudioSeal/TrustMark (35–228 MB models, v2), non-English calibration, and store publishing
(done by the user).
