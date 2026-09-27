# Changelog

All notable changes to this project are documented here.

## [0.2.0] — 2026-09-28

- Quick check reads at most ~1,024 tokens (setting: Tiers → Quick check length); the Deep check (↻) still reads the whole page. Keeps long pages fast, notably on Firefox.

**First public release.** There is no public 0.1.0 — that version number was
an internal development milestone only, never packaged or submitted to a
store (see [`docs/plan.md`](docs/plan.md) "Phases and release"). Everything
below is what ships in this first release.

### Added

- **Page-type routing**: an article, a thread, a video, a subtitle file, a
  search page and an app each get the check that suits them (page text,
  per-item scoring, transcript + voice, timed subtitle scoring, snippet
  markers, or nothing automatic). Per-site override in Options.
- **Two tiers**: an automatic **Quick** check (TMR; a page that reads ≥ 50%
  is re-checked with Fusion before anything is shown) and an on-demand
  **Deep** check (the full Fusion set plus ModernBERT, Binoculars and
  perplexity). The chip shows only from 70%.
- **YouTube transcripts and voice check (experimental, on by default)**:
  reads the transcript through the player's own caption request and,
  optionally, samples short audio clips for likely synthetic narration.
  Detects AI-written scripts and clean/compressed TTS — not every synthetic
  voice, and not a substitute for a watermark check.
- **Presence**: one setting (default **Status chip**) for how much the
  extension shows — On click, Badge, Status chip, Inspector, or Side panel
  — with per-site auto-run rules and a "never on this site" toggle.
- **More entry points**: context menus (page, image, text box), a popup
  paste box and file drop (.txt/.md/.html/.docx), and rebindable keyboard
  shortcuts.
- **Chat/thread/comment adapters**: assistant-only scoring on ChatGPT,
  Claude, Gemini, Copilot and Perplexity-style UIs; per-comment/per-post
  scoring on Reddit, Hacker News, forums, reviews and YouTube comments.
- **Slop filter** (off by default): dims/collapses flagged comments, posts
  and reviews, plus a small marker on flagged search-result snippets
  (snippet text only, never the linked page).
- **Site memory** (off by default, local only): a per-domain tally,
  clearable from Options.
- **Battery saver**: Battery Status API / Compute Pressure gating where
  available, a manual toggle where they're not, and an idle-unload timer.
- **Fusion detector mode**: any mix of Fakespot, TMR, ModernBERT, the lite
  model, perplexity and experimental Binoculars, combined by weighted
  average (default), log-odds, vote or max, with an agreement count.
- **Model updates**: "Check for updates" against the Hugging Face API,
  one-click update with rollback, and custom-model support with a licence
  warning.
- **Provenance and watermarks for images**: C2PA / Content Credentials,
  unsigned generator metadata, a from-scratch SD/SDXL/FLUX invisible
  watermark decoder, and C2PA text manifests — with an explicit "cannot be
  checked locally" list (SynthID, Claude's and Gemini's text watermarks,
  Meta Content Seal, Digimarc, TrustMark) rather than staying silent.
- A hidden-Unicode scan, always shown separately from the AI score.

### Fixed (release QA in real Chrome, [`docs/qa-results.md`](docs/qa-results.md))

44 rows tested end to end; 36 passed outright and 8 passed with a documented
caveat (login walls, a native-menu testing limitation, one detector
limitation on casual ChatGPT replies). 23 rows failed on first try and were
fixed, including: the automatic Quick check putting ≥ 50% on plainly human
pages (see "Fixed (false positives)" below); several sites' comments/answers/
reviews/snippets not being scored per item; page types for JS-heavy essay and
shop pages; shared-chat pages scoring every turn as the assistant; the slop
filter, site memory and battery-saver switches not doing anything until
acted on; badge/side-panel/tooltip percentages showing the raw score instead
of the calibrated one; and keyboard shortcuts that took over browser/OS keys
(now Alt+Shift+A/S/V, Control+Shift on macOS).

### Fixed (false positives on human pages, [`docs/calibration.md`](docs/calibration.md#quick-tier-and-false-positives-qa-pass-2026-09-28))

The automatic Quick check now uses TMR instead of the lite model, with any
result ≥ 50% re-checked against Fusion before it's shown, and the chip
raised to show only from 70% (was 35%). On the web eval set this cuts human
texts shown ≥ 50% from 41% to 3%, while AI texts shown ≥ 70% rise from 51%
to 67%. Examples: an r/AskHistorians thread 95% → 41%, Wikipedia 82% → 34%,
a TED talk transcript 53% → 23%.

### Known limitations

- Tuned to favour a low false-positive rate over catching everything:
  paraphrased, edited, or "write like a human"-prompted AI text mostly
  passes, as it does for every public detector.
- Forum-style posts are the hardest genre; non-native English writing scores
  higher on detectors like this (a known bias); text under ~30 words shows
  "—" rather than a number.
- Binoculars, ModernBERT (as a standalone mode) and the voice check are
  experimental / newer and the least-tested paths.
- Calibration is one ~1,900-text web eval set (English only); see
  [`docs/calibration.md`](docs/calibration.md) for full numbers and caveats,
  including the ChatGPT-share limitation (casual 2026 ChatGPT replies read
  low even under Deep — a detector limitation, not a pipeline bug).
- Firefox wasn't covered by the release QA pass (Chrome only); see
  [`docs/qa-results.md`](docs/qa-results.md).
