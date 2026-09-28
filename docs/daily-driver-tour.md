# Daily-driver tour (run before anything is called done)

Run in the user's real Chrome (chrome-devtools MCP), using only agent-opened background tabs, **never setting `video.playbackRate`, and never touching other extensions' state** (the user's speed extension saves whatever rate it sees as their global default), on
the current build after `reload_extension`. For each stop: look at the page as a user would,
hover and click the corner card, then record ✅/❌ and a screenshot. Finish with the error check.
Any ❌, or any extension error, means not done.

| # | Stop | What a user must see |
|---|---|---|
| 1 | YouTube watch (captioned), play muted (leave the speed alone) | Corner card shows Script + Voice within ~30 s; hover explains; click opens details; inline chips under the title |
| 2 | The same video at the user's own speed (their speed extension defaults to 3×; don't change it) | Transcript still scores; voice shows "Voice 1× only" cleanly, no false alarms |
| 3 | YouTube Short | Card present, sensible values |
| 4 | Reddit thread + HN thread | Card shows "n AI"; per-comment markers; slop filter works when on |
| 5 | News article + Wikipedia | Card shows AI %; low on human text; hover and click work |
| 6 | Google results | Snippet markers only; card sensible |
| 7 | `.pdf` URL and an extension-less PDF (e.g. arxiv.org/pdf/…) | Quiet "can't read this page"; right-click selected text still works; no errors |
| 8 | chrome:// page, Web Store page | Popup says unsupported, calmly |
| 9 | A tab opened **before** `reload_extension` | Popup and card recover (or ask to refresh) instead of failing silently |
| 10 | Popup on an article | Clean layout, Deep ↻ works, toasts not error screens |
| 11 | Options page | Every control saves, persists after reload, has a visible effect; no page jumps |
| 12 | Side panel | Lists flagged items; click scrolls |
| 13 | Dark mode page + small window (≤ 800 px) | Card legible, never covers content meaningfully |

**Error check (mandatory):** `list_console_messages` for the extension's service worker and the
offscreen document, plus chrome://extensions → Errors. The result must be zero error-level
entries from the extension. Warnings that are only deprecation notices from the browser are
noted, not failures.
