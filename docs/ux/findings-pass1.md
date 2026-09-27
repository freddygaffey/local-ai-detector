# UX walkthrough — pass 1 (rough, single-agent, six personas)

Build tested: production `chrome-mv3` build (pre-T7/T9: no Fusion mode, no agreement
indicator, no Presence modes — confirmed by grep, `fusion`/`agreement`/`presence`/`sidePanel`
don't exist yet in `entrypoints`/`src`). One shared Chrome-for-Testing profile, real Hugging
Face model download (~216 MB, ensemble), fixture server on port 8811 serving the existing
`news.html`/`blog.html` fixtures plus five small custom pages (essay, Reddit-style story,
phishing-style email, a one-line reply, a nav-only blank page).

## Usefulness of this pass

**Worth running the fuller pass.** Of the 8 headline findings below, I'd call **5 real and
non-obvious** (not things you'd get from reading the plan alone): the auto-run/"Analyze
automatically" toggle sitting ON in the shipped build with no per-page consent (#1); the
genuinely human, personal-but-formal student essay scoring 57% "Likely AI-generated patterns"
with no non-native-writer caveat anywhere (#2); the single bold scalar verdict on a
majority-human mixed page (#3); image checks being invisible-by-default with no on-page cue
that anything is even checkable (#4); and the jargon-on-the-main-surface violation of the
plan's own copy rule, confirmed directly in the Options screenshot (#5). The other 3 (copy
consistency, stale-cache label, colour-weight scaling) are smaller but concrete, with exact
strings and screenshots, not generic "consider adding tooltips" filler. One real gap in this
pass: I didn't get a clean end-to-end read on the very-short-text edge case (see Known gaps),
and I did zero Firefox/keyboard/screen-reader testing (out of scope for a Chrome rough pass).

## Per-persona highlights

### 1. High-school English teacher (~80w)
Marks a stack of student essays between classes, five minutes each. Terrified of accusing an
innocent student. Wants one defensible number plus specifics she can point to, not a lecture on
perplexity. Ran `news.html` (mixed human/AI paragraphs) end to end.
- Consent screen and download were clear and fast (screenshot `01`).
- Result: **54%, "Likely AI-generated patterns," 15/41 sentences flagged** (screenshot `02`) —
  technically correct (more AI paragraphs than human), but the bold red banner reads as a
  verdict on the *whole* essay, not "some paragraphs." She'd have to scroll to the pill and
  step through sentences to see which 15 (screenshot `03`) — no per-document summary list yet.
  Real teacher-facing risk: skimming just the top number.
- Liked: "Likely AI-generated patterns" (not "is AI"), and the one-line non-accusatory caveat.
- Wants (T9/T7): a side-panel style report listing exactly which sentences, so she can quote
  them to a student without hunting through highlights; T7's agreement indicator ("3/4
  detectors agree") would help her defend a flag. Wouldn't use Badge or a corner chip — needs
  the detail, not a glance.

### 2. Non-native-English university student (~80w)
Checks her own essay before submitting, terrified of the well-known bias against non-native
phrasing. Wrote a genuinely human essay (screenshot data): three "textbook" academic paragraphs
plus one personal, informal paragraph about her family.
- Result: **57%, "Likely AI-generated patterns," 3/8 flagged** (screenshot `04`) — on 100%
  human text. This is exactly her worst fear, confirmed in this build, and nothing in the UI
  acknowledges non-native writers as a known failure mode.
- No explanation of *why* a sentence was flagged (no keyword, no "this reads unusually uniform"
  hint) — she's left rereading her own words trying to guess what looked "AI" about them.
- Wants (T9/T7): the plan's promised per-sentence "why" explanation and a plain caveat about
  non-native writing; would use "On click" (she invokes it deliberately, doesn't want it
  running on drafts she hasn't finished). T7's fusion/agreement wording could help *if* phrased
  gently ("detectors disagree" reads as reassuring here), but risks more anxiety if not careful.

### 3. Journalist / fact-checker on deadline (~80w)
Verifies a photo's provenance fast, wants evidence she can cite in a correction or a story.
Used `news.html`'s four images (C2PA-signed, SD watermark, unsigned AI-claim, cross-origin).
- Popup: **"Checked 0 / 3"**, all behind "Allow image checks on 2 sites" (screenshot `07`); no
  badges rendered on the page at all (screenshot `06` — the C2PA photo shows nothing). This is
  correct production-build behaviour (no host permission yet), but there's zero on-page signal
  that these images are even checkable until she notices the small popup button.
- Wants (T9): the planned "Check image for Content Credentials" right-click entry point badly —
  right-clicking a specific photo mid-story beats hunting for a popup button. T7's agreement
  indicator less relevant to images specifically, but per-genre honesty in wording ("no signals
  ≠ human-made," already present) is exactly the citable-caveat language she needs. Preferred
  Presence: Status chip (fast, expandable, doesn't block her reading the article).

### 4. Casual reader tired of AI slop (~80w)
Wants a glanceable signal and zero friction, hates anything covering the page. Loaded a
Reddit-style AI-written short story (`story.html`).
- **The extension had already auto-analyzed the page before I did anything** (screenshot `08`,
  "Analyzing… 50%" appearing unprompted seconds after load; confirmed via
  `chrome.storage.sync`: `"autoRun": true` in this build/profile, though the current source's
  `DEFAULT_SETTINGS.autoRun` is `false` — worth the team's own check of what actually ships).
  For this persona that's the *opposite* of "zero friction": it ran without being asked, and
  left a small but persistent, expanded pill (score + nav buttons) sitting over the corner.
- Wants (T9): **Badge** as the default, full stop — this persona is the textbook case for why
  T9 exists ("today's UI is too intrusive"). No interest in Fusion/agreement detail.

### 5. Privacy-minded developer (~80w)
Reads permissions and settings before trusting anything, uninstalls on any phoning-home.
Opened Options → Detection (screenshot `09`).
- Liked: clear per-toggle explanations, "Every model is pinned to a known revision," licence
  list, and (from README/PRIVACY, not re-verified this pass) documented Hugging Face-only
  network activity.
- Confirmed **"Analyze automatically" toggle rendered ON** in this profile — exactly the kind
  of silent-default this persona actively checks for and would flag as a trust issue if it
  shipped that way.
- The whole Detection tab is jargon-forward on the *main* surface (WebGPU, fp16/4-bit,
  "calibration," "TMR RoBERTa," "e5-small," "Perplexity / burstiness") — this persona is fine
  with that, in fact prefers it visible, so this is a case where T9's "hide jargon behind
  Details" rule should have an explicit power-user escape hatch, not just simplification.
- Wants (T7): the full Fusion picker (choose exact detector subset) and agreement/log-odds
  detail — this is their persona. Preferred Presence: On click + Side panel for deep dives;
  would actively dislike Badge/Status chip (too little transparency).

### 6. Older, less-technical user (~80w)
Forwarded a suspicious "PayPal" email, easily overwhelmed, needs one plain answer. Tested a
phishing-style email fixture, a one-line reply, and a blank/no-text page.
- Email: **58%, "Likely AI-generated patterns"** (screenshot `10`) — plain verdict text reads
  fine for this persona ("Most of this text reads like the detectors' AI-generated examples").
  But 0/5 sentences individually flagged despite a 58% overall score is confusing on its own —
  nothing reconciles "no sentence was flagged" with "likely AI overall" in the UI.
- One-line reply ("Sounds good, see you at 3.") hit **"Downloading model… Starting…"** even
  though models were already cached from earlier personas — a second, unexplained "downloading"
  moment is exactly what would make this persona worry about data usage. (I didn't manage to
  observe this one through to a final verdict in this pass — see Known gaps.)
- Blank/nav-only page: **"Couldn't find any readable text on this page." + Retry** — plain and
  honest, good copy.
- Wants (T9): Badge or nothing until asked; would be lost by any settings surface. On-click,
  never auto-run.

## Findings (deduplicated, severity + fix)

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | "Analyze automatically" (autoRun) was **ON** in the tested build/profile — pages get silently analyzed and the pill auto-expands with no per-page consent, contradicting `DEFAULT_SETTINGS.autoRun = false` in current source. | **Major** | Confirm what actually ships (build vs. source may be out of sync); ship T9's "On click" as the true default; add a one-time toast/notice the first time auto-run fires on a new site. |
| 2 | A genuinely human essay with one personal/informal paragraph and three formal-academic ones scored 57% "Likely AI-generated patterns," with no caveat about the known non-native-writer/formal-writing false-positive risk anywhere in the UI. | **Major** | Add the plan's "one short caveat" specifically surfacing this failure mode when the band is `ai`/`mixed`; consider a distinct, softer treatment for scores just past the threshold. |
| 3 | A majority-human mixed page (15/41 sentences flagged) still renders as a single bold "54% — Likely AI-generated patterns" banner; a time-pressed reader (teacher) sees only the top-line verdict. | **Major** | Lead with the sentence ratio for mixed bands ("15 of 41 sentences look AI-written") ahead of/beside the %; prioritize T9's side-panel sentence list for this workflow. |
| 4 | Image provenance is fully invisible until a per-origin permission is granted — no on-page cue (dashed badge, "?" marker) shows an image is even checkable; the grant button is buried below Text/Hidden-characters cards in the popup. | **Major** | Add a neutral "not yet checked" marker on eligible images; move the permission button above the fold; ship T9's right-click "Check image" entry point. |
| 5 | Options → Detection puts WebGPU/fp16-4bit/calibration/TMR-RoBERTa/e5-small/"Perplexity-burstiness" jargon directly on the main settings surface — this is the exact list the plan itself says must go behind "Details," and it's currently not. | **Major** (for T9) | Move these behind an explicit "Advanced"/"Details" disclosure per the plan's own copy rule; keep a power-user escape hatch (persona 5 wants this detail, just not by default). |
| 6 | Inconsistent "try again" language: no-text page says **"Retry"**, SPA-stale pill says **"Scan again"** (per qa.md) for conceptually the same action. | Minor | Standardize on one term ("Scan again"). |
| 7 | The same "Downloading model… Starting…" label is used for a genuine first-run network download and for reloading an already-cached model into memory — an older/anxious user has no way to tell these apart. | Minor | Use a distinct label with no MB/percent implication for cache loads (e.g., "Loading model…"). |
| 8 | Verdict colour/weight doesn't scale with distance from the 50% boundary — 54–58% renders in the same bold red as a hypothetical 95%, which is exactly where nuance matters most (borderline/mixed cases). | Polish | Graduate colour intensity/weight with distance from threshold, not just the label text. |
| 9 | 58% overall with **0/5 sentences individually flagged** (older-user email fixture) — nothing in the popup reconciles an "overall AI" verdict with zero flagged sentences. | Minor | Add a line explaining overall vs. per-sentence scoring can disagree on short/uniform texts. |

## Copy audit (consolidated — CUT / REWORD / MOVE-BEHIND-DETAILS only)

| Text (verbatim, where seen) | Verdict | Rewrite / destination |
|---|---|---|
| "Per-detector score" / "Classifier 45%" / "Perplexity / burstiness 38%" (popup Text card) | MOVE-BEHIND-DETAILS | Keep the overall %, move the per-detector breakdown under a "Details" toggle for non-power personas (teacher/student/older-user don't need "burstiness"); privacy-dev/journalist can expand it. |
| "Ensemble classifier … The standard one (TMR, ~126 MB) ranked texts better and flagged fewer human texts in our tests; the lite one (~34 MB) is smaller and faster." (Options) | MOVE-BEHIND-DETAILS | This whole control (model codenames, MB sizes, "in our tests") is jargon per the plan's own rule. Move to an "Advanced" section; keep a one-line "Speed vs. accuracy" toggle on the main surface if needed at all. |
| "Use the GPU (WebGPU) when available … runs different (fp16/4-bit) model weights … its own, less-tested calibration." (Options) | MOVE-BEHIND-DETAILS | Same — "fp16/4-bit," "calibration" are explicitly named in the plan as jargon that must go behind Details. |
| "Standard (TMR RoBERTa)" / "Lite (e5-small)" (dropdown options) | REWORD | "More accurate (slower)" / "Faster (slightly less accurate)" — model codenames mean nothing to 5 of 6 personas. |
| "Downloading model… Starting…" (pill/popup, shown identically for a cache reload) | REWORD | "Loading model…" when reading from cache; reserve "Downloading" + MB/percent for genuine network fetches. |
| "Retry" (no-readable-text popup state) | REWORD | "Scan again" — matches the SPA pill's existing wording for the same underlying action. |
| "This mode needs a fresh download consent — reopen the popup to confirm it." (error fallback) | REWORD | "This mode needs a new download — reopen the popup to allow it." ("consent" is legalese for this audience.) |
| 54%/57%/58% shown at identical bold-red weight regardless of closeness to the 50% line | REWORD (visual) | Not text, but flagged here since it's a "hedging repeated via styling" issue: graduate weight/colour so borderline scores don't read as confidently as extreme ones. |

## Preferred Presence default, per persona

| Persona | Presence default | Why |
|---|---|---|
| Teacher | Side panel (Inspector as fallback) | Needs the full flagged-sentence list to defend a grade, not a glance. |
| Non-native student | On click | Invokes deliberately on her own drafts; auto-run on an unfinished draft would be unwelcome. |
| Journalist | Status chip | Fast, expandable, doesn't cover the article; needs image right-click more than a popup. |
| Casual reader | Badge | Confirmed by this pass: auto-run + persistent pill is the opposite of what they want. |
| Privacy-minded developer | On click + Side panel | Wants full transparency and control, actively dislikes silent auto-run. |
| Older, less-technical user | Badge (or nothing until asked) | Minimal surface, no settings, no auto-run. |

## Known gaps in this pass

- The very-short-text edge case (older-user "Sounds good, see you at 3.") wasn't followed
  through to a final verdict — the script's wait window caught it mid "Downloading model" and I
  didn't re-verify the end state given the time budget. Worth a direct look in a fuller pass.
- No Firefox, no keyboard-only navigation, no screen-reader pass, no contrast measurement —
  out of scope for this rough Chrome-only pass.
- The `autoRun: true` finding's root cause (stale build vs. a real settings bug) wasn't
  isolated; I verified the *symptom* (confirmed via screenshot of the Options toggle and a
  direct `chrome.storage.sync` read) but not the cause.

## Screenshots

`docs/ux/shots/pass1/` (10 JPEGs, ~550 KB total):
`01-teacher-consent.jpg`, `02-teacher-result.jpg`, `03-teacher-page-highlights.jpg`,
`04-student-result.jpg`, `05-student-page-highlights.jpg`, `06-journalist-image-badges.jpg`,
`07-journalist-popup-images.jpg`, `08-casual-story-pill.jpg`, `09-privacydev-options.jpg`,
`10-olderuser-email-result.jpg`.
