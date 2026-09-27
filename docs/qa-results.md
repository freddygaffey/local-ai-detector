# Release QA results (real Chrome, default settings), 2026-09-28

The matrix in [qa-matrix.md](qa-matrix.md), run by an agent in the user's real Chrome (Chrome 153,
macOS, Apple Silicon, WebGPU) through the chrome-devtools MCP, on its own tabs only. The extension was on
default settings throughout; anything changed for a row (slop filter, site memory, presence, battery
saver, per-site rule, first-run consent) was changed back straight after it and checked. Screenshots are in
[qa/shots/](qa/shots/). Firefox (section C) was out of scope for this pass.

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

- Firefox (section C): out of scope for this pass.
- Nothing was blocked by tool permissions.
