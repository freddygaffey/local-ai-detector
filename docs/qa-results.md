# Release QA results (real Chrome, default settings), 2026-09-28

The matrix in [qa-matrix.md](qa-matrix.md), run by an agent in the user's real Chrome (Chrome 153,
macOS, Apple Silicon, WebGPU) through the chrome-devtools MCP, on its own tabs only. The extension was on
default settings throughout; anything changed for a row (slop filter, site memory, presence, battery
saver, per-site rule, first-run consent) was changed back straight after it and checked. Screenshots are in
[qa/shots/](qa/shots/). Firefox (section C) is in [its own section](#firefox-section-c) below.

**Tally: A + B = 44 rows. ✅ 36 · ⚠️ 8 · ❌ 0.** 23 rows failed on the first try and were fixed
(commits in the rows), then re-tested in the browser.

Legend: ✅ pass · ⚠️ works with a caveat · ❌ bug. "Fixed" = the row failed first; the commit fixed it.

## False positives (priority 0)

See [calibration.md, "Quick tier and false positives"](calibration.md#quick-tier-and-false-positives-qa-pass-2026-09-28)
for the diagnosis and the eval-set numbers. Live, Quick pass as shown on each page (old = lite, the previous default):

| Page | Old | New |
|---|---|---|
| TED talk transcript (Ken Robinson) | 53% | 23% |
| r/AskHistorians thread | 95% | 41% |
| Wikipedia "Hedgehog" | 82% | 34% |
| BBC News article | 52% / 82% | 47% / 69% (chip hidden) |
| Slate Star Codex essay | 86% | 20% |
| Paul Graham essay | 91% | 39% |
| Fresh AI story / how-to / review / forum post | 83–95% | 98% each |

Commit: e9b8b26.

## A. Sites

| # | Site | Result | Notes | Shot |
|---|---|---|---|---|
| A1 | YouTube watch, captioned (TED) | ✅ fixed | `Transcript: AI 23%` (was 53%), `Voice: AI 3% · 2 clips`, no page chip. During a pre-roll ad the chip said "No transcript": captions are now read after the ad (e9b8b26). YouTube once showed its ad-blocker wall (another extension in this profile; external). | A1-youtube-ted.jpeg |
| A2 | YouTube, no captions | ✅ | Silent timelapse: `No transcript`, `Voice: —` (no speech to score, correct). | A2-youtube-no-captions.jpeg |
| A3 | YouTube Short | ✅ fixed | Voice never auto-started when landing on /shorts (the router gates the landing page first and the Short's id was recorded while gated). Now `Transcript: AI 23%`, `Voice: AI 5% · 3 clips` (6ca19a9). | A3-youtube-short.jpeg |
| A4 | YouTube home / search | ✅ | Nothing automatic. | A4-youtube-search.jpeg |
| A5 | Vimeo video | ✅ | `app`→video page offers "Check the voice" on click; session runs (0 clips on Big Buck Bunny: no speech). No `<track>`, so no transcript. A "processing" video page also showed the voice chip with no playable video (minor). | A5-vimeo.jpeg |
| A6 | Reddit thread (new) | ✅ fixed | Page 41% (was 95%), chip hidden (nothing past the filter threshold), per-comment labels 6–39%; the mod's boilerplate welcome reads 82% (Fusion agrees: templated text). Per-item labels used the wrong curve (e9b8b26) and short comments were scored together with their neighbours (aa21623). | A6-reddit-thread.jpeg, A6-reddit-popup.jpeg |
| A7 | old.reddit.com thread | ⚠️ external | old.reddit now requires a login for logged-out readers; the login wall is quiet (4 words, "—"). Tested new Reddit instead (A6). | A7-old-reddit-login-wall.jpeg |
| A8 | Hacker News item | ✅ | Per-comment labels, short replies "Too short". | A8-hn-item.jpeg |
| A9 | Stack Overflow question | ✅ fixed | Only the one-line comments under posts were scored, never the answers (40ba65a); a long answer used the whole token budget and later answers showed "AI 3%" (978ce3a, 40ba65a: unscored items now "—"). Now 21 of 31 items scored, 3–34%. | A9-stackoverflow.jpeg |
| A10 | Wikipedia article | ✅ fixed | 34% (confirmed by Fusion; lite said 82%), chip hidden; hover peek shows "AI 34%". | A10-wikipedia.jpeg |
| A11 | News article | ✅ | Guardian 39%; BBC 47% and 69% (confirmed), chip hidden (below 70%). | A11-guardian.jpeg, A11-bbc.jpeg |
| A12 | Medium / Substack post | ✅ | Substack (ACX) 41%; Medium 34%. | A12-substack.jpeg, A12-medium.jpeg |
| A13 | WordPress blog post | ✅ fixed | wordpress.org news 48%. paulgraham.com (text in a `<td>` with `<br>`s) was "app (little prose)" and got nothing (b2f7a6f); now article, 39%. | A13-wordpress.jpeg |
| A14 | Discourse forum topic | ✅ fixed | thread (Discourse); post bodies (`.cooked`) weren't matched (40ba65a). Post labelled 12%. | A14-discourse.jpeg |
| A15 | Amazon product reviews | ✅ fixed | Product pages were "app (shop)" and the full review list now needs a login (b2f7a6f). Product page: 13 reviews labelled; one reads AI 97% (and reads like it). | A15-amazon-reviews.jpeg |
| A16 | Google results | ✅ fixed | Search type, no page chip. Google's markup had changed: only two wrappers matched, so snippets were never scored separately (aa21623). Now 9/9 results scored (9–50%); no marker because none reached the filter threshold. | A16-google.jpeg |
| A17 | Bing / DuckDuckGo | ✅ fixed | Bing: 10 results; several snippets shared one score until aa21623. DuckDuckGo snippet selector added (9515adc). No markers on the test queries (nothing past the threshold). | A17-duckduckgo.jpeg |
| A18 | X post (logged out) | ✅ | Readable; a 22-word post shows "—", quiet. | A18-x-post.jpeg |
| A19 | GitHub repo / issue | ✅ | Repo = app (nothing); issue = thread, 40%, no UI chrome scored. | A19-github-issue.jpeg |
| A20 | Gmail / Google Docs | ⚠️ | Both route to app (nothing automatic). Gmail was only classified by URL, never viewed (the user's inbox). Right-click can't be driven through CDP (native menu); the handlers were exercised via their hooks in B6. | A20-google-docs.jpeg |
| A21 | ChatGPT shared conversation | ⚠️ fixed | Was "app (little prose)", and every turn (the user's too) read as the assistant because ChatGPT's classes contain "…-inset-bottom" (9515adc). Now thread (shared chat), assistant replies only, auto-run retries until the SPA has rendered. **Caveat:** real 2026 ChatGPT replies (casual, agentic) read 3–12% Quick, 21% Fusion, 28% Deep: a detector limitation, not a pipeline one. | A21-chatgpt-share.jpeg |
| A22 | Raw `.vtt` / `.srt` | ✅ | Served as text: subtitles type, `Transcript: AI 97%` (Deep 93%), segments with timestamps ("0:01 AI 91%"). Served as `text/vtt`/octet-stream, Chrome downloads the file instead (deleted). | A22-vtt.jpeg |
| A23 | Page with a C2PA-signed image | ⚠️ permission | Local page with the c2pa test image: image checks need the optional host permission for the image's origin, which needs a user click to grant; not granted here (it would change the user's permissions). Thumbnails correctly skipped (2 of 4 images considered). | A23-c2pa.jpeg |
| A24 | chrome:// / Web Store | ✅ | Popup: "Can't read this page." No errors. | A24-chrome-page-popup.jpeg |

## B. Workflows

| # | Workflow | Result | Notes | Shot |
|---|---|---|---|---|
| B1 | Fresh install → popup | ⚠️ method | Extensions don't load in an isolated browser context (`ERR_BLOCKED_BY_CLIENT`), so tested by clearing `consentedDownload` and restoring it. Checklist: TMR (Quick, locked), Fakespot, Spectra-AASIST3 ticked; W2V2 (alternative voice) unticked; total ~594.9 MB. | B1-first-run-checklist.jpeg |
| B2 | Download & enable | ⚠️ | Enables immediately (all models already cached). Real download progress was seen in B4's Deep run of the uncached extras, not by re-downloading the defaults. | – |
| B3 | Auto Quick check on an article | ✅ fixed | AI story: chip `AI 98%`; Wikipedia: chip hidden, hover peek showed "…" (and "no result yet" to screen readers) until e025d0e; now "AI 34%". | B3-auto-quick-chip-hover.jpeg, B3-peek-hidden-chip.jpeg |
| B4 | Deep check ↻ | ✅ fixed | Pill ↻ and popup ↻: all six detectors, labelled "Deep" (32% on Wikipedia). Popup progress printed chunk counts as bytes ("41 B / 189 B") until c8f6841. Side panel ↻ present (B9). | B4-deep-pill.jpeg, B5-popup-deep-result.jpeg |
| B5 | Analyze selection, no selection | ✅ | "Selection" disabled with the tooltip "Select text first"; no error screen. | B5-popup-deep-result.jpeg |
| B6 | Right-click: selection / page / image / text box | ⚠️ fixed | Driven through the handlers' test hooks (native menus can't be clicked). Selection ✅. Text box ❌→✅: it messaged `analyze` from the service worker to itself ("No response"), and results of menu/shortcut runs weren't shown on quiet pages (c8f6841). Page = same path as "Analyze page". Image needs a host-permission grant (as A23). | B6-rightclick-selection.jpeg, B6-rightclick-textbox.jpeg |
| B7 | Popup paste box | ✅ fixed | 68-word human paragraph: 13% Human; unusual characters 2 (NBSP + zero-width space). Showed "Images: checking…" forever for pasted text (801c74a). | B7-paste-box.jpeg |
| B8 | Popup file drop (.txt, .docx) | ✅ | Both scored (98% AI on the AI story). | B8-file-txt.jpeg, B8-file-docx.jpeg |
| B9 | Side panel | ✅ fixed | Listed "Block 3219-2 · sentence 1" with raw engine scores; now the sentence text and calibrated % (c6407d5). Clicking scrolls the page (Wikipedia: to y=768). Wikipedia citations split sentences ("4] They…"), fixed in the same commit. Opened as a page tab (the panel itself needs a user gesture). | B9-side-panel.jpeg, B9-side-panel-wikipedia.jpeg |
| B10 | Slop filter on (thread page) | ✅ fixed | Did nothing with the default chip Presence until the chip was expanded (9f379ff). Now the 97% Amazon review is dimmed with `AI 97% · Show`, chip "1 AI". Turned back off. | B10-slop-filter.jpeg |
| B11 | Site memory on | ✅ fixed | Verdicts were recorded but nothing showed them (5a9d6b0). Popup now shows "This site: 0/3 AI" after three Wikipedia pages. Turned off and the stored tally removed. | B11-site-memory-popup.jpeg |
| B12 | Per-site "never" | ✅ | "Never on this site" → reload → idle. Rule removed afterwards. | B12-never-on-site.jpeg |
| B13 | Options: toggles and selects | ✅ | No scroll jump on toggle (y 824 → 824); changes persist across reload. Restored. | B13-options.jpeg |
| B14 | Presence presets | ✅ fixed | Badge: toolbar badge only (showed the raw score "84" next to 98% until 1d3f78e); Chip: default; Inspector: pill + heatmap; Side panel: `openPanelOnActionClick` on; On click: nothing automatic. Restored to Status chip. | B14-inspector.jpeg, B14-on-click.jpeg |
| B15 | Keyboard shortcuts | ⚠️ fixed | Browser-level shortcuts can't be sent through CDP. The defaults were Cmd/Ctrl+Shift+A/S/V, which took over paste-as-plain-text, Chrome's tab search and Firefox's add-ons page; now Alt+Shift (Control+Shift on macOS) (bf9b1f9). **The user's current install keeps ⇧⌘A/S/V** until changed at chrome://extensions/shortcuts or reinstalled. | – |
| B16 | Models: updates / rollback / custom | ✅ fixed | "Check for updates" offered every model's own pinned revision as new (9df49c3); now "Up to date." Rollback disabled with no previous revision. Custom repo check shows "licence: mit … Use this model" (not applied). | B16-models.jpeg |
| B17 | Battery saver (manual) | ✅ fixed | The switch changed nothing with the default on-battery action; it now pauses automatic checks (page stayed idle), and unplugged with "Normal" the voice check drops to Light (7499342). Restored. | B17-battery.jpeg |
| B18 | Idle unload (5 min) | ✅ | Warm TMR run 75 ms (13 ms with the model hot); after 7 idle minutes the next run took 548 ms (model reloaded from cache), then 13 ms again. Note: any tab update in the browser counts as activity, so busy browsers unload later. | – |
| B19 | Voice on non-YouTube `<video>` via right-click | ✅ | Local page with a Wikimedia Commons speech video (CORS): the menu handler's message started a session, corner chip `Voice: AI 0% · 2 clips` (a real 1980s radio address). A music-only clip correctly scored nothing (speech gate). | B19-voice-html5-video.jpeg |
| B20 | Hidden-Unicode markers | ✅ | Three markers (`⟦ZW⟧`, `⟦ZW×2⟧`, `⟦ZW⟧`) with neutral wording ("not evidence of AI"). Minor: the ×2 run's label names only the first character. Shown once the page is displayed (Show on page), as designed. | B20-unicode-markers.jpeg |

## Other changes made during the pass

- Copy: TMR, not lite, is named as the automatic pass (312cfb4).
- Automatic runs retry after a momentary CPU-pressure reading instead of skipping the page (6ca19a9).

## Remaining ⚠️

- A7 old.reddit: login wall (external). A20 Gmail not opened (user data); native context menus can't be clicked via CDP.
- A21 ChatGPT share: pipeline works; casual 2026 ChatGPT replies read low (detector limit).
- A23 / B6 image: image checks need a per-origin permission grant by a user click.
- B1 fresh install: isolated contexts don't load extensions; tested by resetting consent. B2: models already cached.
- B15 shortcuts: can't be pressed through CDP; defaults changed; the user's install keeps ⇧⌘A/S/V until rebound.

## Not done / blocked

- Nothing was blocked by tool permissions.

## Firefox (section C)

Firefox 156.0.1, macOS, Apple Silicon (WebGPU with shader-f16), production build installed as a temporary
add-on in a throwaway profile (scratchpad, deleted afterwards). No logins. Driven two ways:

- **geckodriver/Marionette** (classic WebDriver session): pages, the real popup (opened from the toolbar
  button and clicked in place), the sidebar, native context menus (synthesised right-click, item activated
  in Firefox's own menu), options.
- **No WebDriver** (Firefox started with `-start-debugger-server`, driven over the remote debugging
  protocol) for YouTube and Google: with WebDriver on (`navigator.webdriver`), YouTube refuses playback
  ("Something went wrong") and serves empty caption bodies even to its own player, and Google answers
  with its `/sorry` bot page.

Screenshots are native window captures (`FF-*` in [qa/shots/](qa/shots/)); the popup is drawn in from
its own snapshot. Firefox runs the event page + dedicated `inference-worker` / `voice-worker` (no
offscreen document): engine info `device: webgpu, shaderF16: true, threads: 1, crossOriginIsolated:
false, cache: cache-api`. `web-ext lint`: 0 errors (3 warnings: the dynamic `import()` in the two
workers and ORT's `Function` use, as before).

**Tally: 12 rows. ✅ 11 · ⚠️ 1 · ❌ 0.** 4 rows failed on the first try and were fixed in code (A6, B1, B6, B9); A10 was sped up but stays ⚠️.

| # | Row | Result | Notes | Shot |
|---|---|---|---|---|
| A1 | YouTube captioned (TED) | ✅ | `Transcript: AI 23%` (same as Chrome), `Voice: AI 2% · 2 clips` after ~2 min of playback; no page chip. The MAIN-world captions helper runs (Firefox supports `world: "MAIN"` since 128; `strict_min_version` is 140). Firefox 156 has unprefixed `captureStream()`, so the `mozCaptureStream` fallback isn't used; the tab stays audible while voice listens. Voice's AudioContext starts suspended until the page gets a click (autoplay policy, same as Chrome); the no-WebDriver profile allowed Web Audio by pref instead. Needs the no-WebDriver run (see above). | FF-A1-youtube-ted.jpeg |
| A6 | Reddit thread | ✅ fixed | thread (Reddit), page 41% (Chrome: 41%), 12 per-comment labels (`AI 72%` mod welcome, 6–45%, "Too short"). **Bug (both browsers):** Reddit hides every `:not(:defined)` element, and our chip/pill/tooltip/transcript/voice hosts are undefined custom elements, so the chip was invisible and couldn't be expanded to show the labels. Hosts now force `visibility: visible !important` (891743f). | FF-A6-reddit-thread.jpeg, FF-A6-reddit-popup.jpeg |
| A10 | Wikipedia | ⚠️ slow | "Hedgehog": 34% (Chrome: 34%), chip hidden, hover peek shows `AI 34%`. **Speed:** Quick (TMR on WebGPU) took ~9–10 s for the 4096-token budget (Chrome's timing table predicts ~1 s); pages that lean AI are then confirmed by Fusion, whose Fakespot runs single-threaded WASM on Firefox (~23 s). Before the fix the event page (and every loaded model) was dropped ~30 s after each run, so each page reloaded the models, and the confirmation re-ran TMR: cold 70 s / warm 46 s. Now 37 s cold / ~35 s warm when confirmation runs, ~10 s when it doesn't (03fc73f). TMR on WASM (Firefox on Linux, no WebGPU) measured 35 s for the same page. | FF-A10-wikipedia-peek.jpeg |
| A16 | Google results | ✅ | search (Google), no page chip. Firefox gets different Google markup than Chrome; a diagnostic build (not committed) logged 9/9 snippets scored, 23–37%, so no markers. | FF-A16-google.jpeg |
| A22 | `.srt` file (served as text/plain) | ✅ | subtitles (subtitle file), `Transcript: AI 97%`. Minor (shared with Chrome): the popup says "No result" on a subtitle page, since the transcript isn't the tab's page result. | FF-A22-srt.jpeg |
| B1 | Fresh install → popup | ✅ fixed | Genuinely fresh profile: checklist TMR (locked), Fakespot, Spectra-AASIST3 ticked, W2V2 unticked, ~594.9 MB. Firefox also opened our sidebar by itself on install (`sidebar_action` defaults to `open_at_install`), showing "No result yet"; now off (ffc162a). | FF-B1-first-run-checklist.jpeg |
| B2 | Download & enable | ✅ | Real download from empty: text models then voice model, byte progress, done in 76 s; all in the Cache API afterwards (IndexedDB fallback not needed; a 5 MB Blob round trip through IndexedDB on the extension origin also checked). | FF-B2-download-progress.jpeg |
| B3 | Auto Quick chip | ✅ | AI-written article: chip `AI 98%` (Quick confirmed by Fusion) in 11 s; Wikipedia: chip hidden, hover peek `AI 34%`. | FF-B3-auto-quick-chip.jpeg, FF-A10-wikipedia-peek.jpeg |
| B4 | Deep check ↻ | ✅ | Popup ↻ → inline "Download & run (556 MB)" → progress → six detectors, labelled DEEP. Hedgehog Deep 32% (Chrome: 32%). Slow on Firefox: ~140 s per long article (ModernBERT, Binoculars on single-thread WASM). | FF-B4-deep-popup.jpeg |
| B6 | Context menus | ✅ fixed | Firefox's real menu, all four entries: page (result revealed on the page), selected text (4 sentences, 97%), text box (97%, 7 flagged), image (`CR` badge on a C2PA image). **Bugs:** the image entry awaited `permissions.contains()` before `permissions.request()`, which Firefox then refuses (no longer inside the click); and Firefox menus treat `&` as an access key, so the label read "Credentials  watermarks" (2f35d74). In Firefox the `<all_urls>` content-script match already grants image access here, so no prompt appeared. | FF-B6-menu-page.jpeg, FF-B6-menu-selection.jpeg, FF-B6-menu-textbox.jpeg, FF-B6-menu-image.jpeg |
| B9 | Sidebar (in place of the side panel) | ✅ fixed | Lists flagged sentences with text and %, follows the active tab; clicking one scrolls the page (y 0 → 162) and shows its tooltip. **Bug:** Presence "Side panel" did nothing in Firefox (Chrome's `sidePanel.setPanelBehavior` has no Firefox counterpart). Now the toolbar icon drops its popup and toggles the sidebar (`sidebarAction.toggle()` from `action.onClicked`); back to the popup when Presence changes (ffc162a). | FF-B9-sidebar.jpeg |
| B13 | Options | ✅ | Real click on a checkbox at scroll 1300: stays at 1300; select change at 2000: stays; both persist across reload; restored. | FF-B13-options.jpeg |

Other Firefox fixes: the popup's action row overflowed 360 px ("Never on this s…" and a horizontal
scrollbar) with Firefox's font metrics; the row now wraps (ffc162a, FF-popup-buttons-wrap.jpeg).
`scripts/e2e/firefox.mjs` forces the Inspector presence for its highlight checks, as the Chrome suite does
(it failed 5 steps against the current default of Status chip); now 18/18 (headless, WASM path, real downloads).

Chrome safety: the shared changes are the overlay-host visibility (inline style only), the per-model
score memo in `detect.ts` (keyed on the loaded model object; results identical, 482 unit tests pass), the
permission request order in the image menu handler, and the popup row wrap (no change where the row
already fits). The keep-alive change is inside the Firefox worker client only; the sidebar toggle runs
only where `sidebarAction` exists; `open_at_install` is a `sidebar_action` key (absent from the Chrome
manifest). Both builds, typecheck and unit tests pass after every change.

### Firefox remaining ⚠️

- A10 / B4 speed: Firefox's WebGPU ran TMR ~8× slower than Chrome's figures, and WASM is
  single-threaded (no cross-origin isolation for extension pages, bug 1673477). A Wikipedia-length page
  takes ~10 s Quick, ~35 s with the Fusion confirmation, ~140 s Deep. On Linux (no WebGPU) Quick alone
  is ~35 s. A smaller Quick token budget on Firefox would help but changes results; left as a decision
  (it could be a setting).
- YouTube and Google bot-wall WebDriver-driven Firefox; both were tested without WebDriver instead.

## Options audit (2026-09-28)
Every control traced to its reader, then exercised live in Chrome (options page in its own tab):
each one saved, survived a reload, and showed the new value; the page height stayed at one
value across all changes (no jumping). The user's settings were snapshotted and restored.

| Control (before) | Problem found | After |
|---|---|---|
| Mode | Worked. Fusion detectors hidden unless Mode = Fusion, but Quick confirmation also uses them | Kept; hint "For checks you start." |
| Fusion: presets, detector list, method radios with blurbs | Third copy of the detector list; long | Presets + "Combine by" select + one summary line; detectors moved to the matrix |
| Tiers: Quick detectors, Deep detectors (two lists) | Duplicated the Fusion list; separate section | One detector matrix (Fusion / Quick / Deep columns) in Detection; keep-one-per-column guard |
| Tiers: hidden `autoRunQuick` (no UI since an earlier fix) | Dead-end: if ever off, auto-run stayed off with no control to turn it on | Migrated into Auto-run = Never; one auto-run control |
| Highlight style, Min words, Max tokens, Hidden-Unicode, GPU | Worked | Terse labels |
| Check images for provenance | Worked | "Image provenance" |
| Auto-check model updates (in Detection) | Worked, wrong section | Moved to Models: "Check for updates daily" |
| Presence preset | Kept showing the old preset after a toggle was changed | Shows "Custom" when toggles differ; picking a preset resets them |
| Auto-run: Always / Never / Ask | "Ask" never built (behaved as Never) | Always / Never; stored "ask" migrated to "never" |
| Surface: Popup | Dead: nothing read it | Removed |
| Surface: Side panel | Dead: behaviour keyed off the preset name, so the toggle did nothing | Toggle now drives "toolbar icon opens the side panel" (Chrome and Firefox) |
| Popup "Show on page" | Only for the On click preset name | Shown whenever neither highlights nor the card paint the page |
| Surface: Toolbar badge, Corner chip, Page highlights | Worked | Labels "Corner card" etc. |
| Chip corner, Chip auto-hide | Worked | "Card corner", "Card shrinks below (%)" (defaults owned by the card work) |
| Per-site rules | "Ask" offered; `https://Example.com/x` stored verbatim and never matched | Always / Never; host normalised; titled "Auto-run per site" |
| Page type per site | Worked | Shared host normaliser; one-line hint |
| Battery (6), Slop filter (10), Voice (5), Site memory (2) | Worked | Terse hints; "(%)" units |
| Whole page | Rows keyed by label, so the three "On" rows collided: focus was restored to the wrong control after a re-render | Keys prefixed with the section |
| Whole page | Didn't follow changes made elsewhere (popup), and could write back stale nested values | Follows `watchSettings` |

Removed/moved nav entry: "Tiers" (now inside Detection). Row padding reduced.
