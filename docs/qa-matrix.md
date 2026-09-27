# Release QA matrix (real Chrome, default settings)

Every row must be seen working in a real, logged-in Chrome (via the chrome-devtools MCP, agent-opened
tabs only) on **default settings**, with a screenshot, before v0.2.0. Result per row:
✅ pass / ⚠️ works with a caveat / ❌ bug (link the fix commit).

## A. Sites (does the page type, auto Quick check and display make sense?)

| # | Site | Expected page type | Expected result |
|---|---|---|---|
| A1 | YouTube watch, captioned (e.g. a TED talk) | video | `Transcript: AI n%` within seconds; `Voice: AI n% · k clips` building while playing; no page chip or highlights |
| A2 | YouTube watch, no captions | video | `No transcript`; voice still works |
| A3 | YouTube Short | video | transcript (if any) + voice |
| A4 | YouTube home / search | app | nothing automatic |
| A5 | Vimeo video | video | voice on click; transcript if `<track>` |
| A6 | Reddit thread (new reddit) | thread | per-comment scores, chip shows count; filter works when on |
| A7 | old.reddit.com thread | thread | same |
| A8 | Hacker News item | thread | per-comment scores |
| A9 | Stack Overflow question | thread | per-answer scores |
| A10 | Wikipedia article | article | low score, quiet (chip hidden) |
| A11 | News article (BBC / Guardian / ABC) | article | score; chip only if high |
| A12 | Medium or Substack post | article | score |
| A13 | WordPress blog post | article | score |
| A14 | Discourse forum topic | thread (fingerprint) | per-post scores |
| A15 | Amazon product reviews | thread | per-review scores |
| A16 | Google results | search | snippet markers only, no page chip |
| A17 | Bing / DuckDuckGo results | search | same |
| A18 | X/Twitter post (logged out) | thread | per-post if readable; otherwise quiet |
| A19 | GitHub repo / issue | app or thread | no noisy article scoring of UI chrome |
| A20 | Gmail / Google Docs | app | nothing automatic; right-click still works |
| A21 | ChatGPT / Claude shared conversation | thread (chat adapter) | assistant replies scored only |
| A22 | Raw `.vtt` / `.srt` file | subtitles | transcript-style scoring with timestamps |
| A23 | Page with a C2PA-signed image (contentcredentials.org examples) | article | "CR" badge on that image only; no badges on thumbnails |
| A24 | chrome:// / Web Store page | unsupported | popup says unsupported, no errors |

## B. Workflows

| # | Workflow | Expected |
|---|---|---|
| B1 | Fresh install → popup | checklist lists every default model (lite, Fusion, voice), all ticked, total size |
| B2 | Download & enable | real progress; all models cached afterwards |
| B3 | Auto Quick check on an article | chip appears only above threshold; hover to peek |
| B4 | Deep check ↻ (popup, chip, side panel) | spins, runs all models, result labelled "Deep" |
| B5 | Analyze selection (popup, no selection) | dimmed button, toast, no error screen |
| B6 | Right-click: selected text / page / image / text box | each gives a result |
| B7 | Popup paste box | scores pasted text; hidden-Unicode flags incl. NBSP |
| B8 | Popup file drop (.txt, .docx) | scores file |
| B9 | Side panel | lists flagged sentences, clicking scrolls |
| B10 | Slop filter on (thread page) | AI items collapsed with `AI n% · Show` |
| B11 | Site memory on | tally appears after a few pages |
| B12 | Per-site "never" | nothing runs on that site |
| B13 | Options: toggle and select changes | no page jump, persist after reload |
| B14 | Presence presets (Badge, Chip, Inspector, Side panel, On click) | each behaves as described |
| B15 | Keyboard shortcuts | analyze page, selection, toggle visibility |
| B16 | Model: check for updates / rollback / custom model | works, licence shown |
| B17 | Battery saver (manual toggle) | auto-run paused; voice drops to Light |
| B18 | Idle unload (5 min) | models unloaded, next run reloads |
| B19 | Voice on non-YouTube `<video>` via right-click | result chip |
| B20 | Hidden-Unicode markers on a page | markers shown, neutral wording |

## C. Firefox
Manual pass of A1, A6, A10, A16, B1–B4 in Firefox (event page + worker path).
