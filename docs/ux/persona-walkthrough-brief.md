# Persona walkthrough brief (shared by all persona agents)

Product: "Local AI Detector", a free, open-source Chrome and Firefox extension. It detects
AI-generated text on the current page **entirely on-device** (models download once from Hugging
Face). It also checks images for Content Credentials and open watermarks, and flags hidden or
unusual Unicode characters.
Repo (read-only for you except your own output files): /Users/fred/random_stuff/ai_detector
Read README.md, docs/plan.md (especially the T7 and T9 sections: PLANNED changes, including
Presence modes, battery saver, chat-site adapters, extra entry points, Fusion and WebGPU default)
and docs/qa.md (how the E2E harness drives the extension).

## Build to test
A production Chrome build of the current code is already built at:
  /private/tmp/claude-501/-Users-fred-random-stuff-ai-detector/39e80934-c139-493c-a82e-24de6aa28819/scratchpad/persona-build/.output/chrome-mv3
Do NOT rebuild it or edit anything in that worktree. Drive it in your OWN isolated browser:
puppeteer-core with Playwright's Chromium executable (see scripts/e2e/chrome.mjs and
scripts/e2e/lib.mjs in the persona-build worktree for exactly how: --load-extension, finding the
extension id, opening popup.html / options.html as tabs, reading the pill's shadow DOM, and
triggering context menus or messages). Use a fresh profile dir of your own under
/private/tmp/claude-501/-Users-fred-random-stuff-ai-detector/39e80934-c139-493c-a82e-24de6aa28819/scratchpad/personas/<your-persona>/profile.
A first run downloads the models (~216 MB). That's expected; experience it as the persona would.
Serve fixture pages with `node scripts/e2e/server.mjs <your port>` from the persona-build
worktree. You may also write your OWN local fixture pages that fit your persona (e.g. a student
essay, a ChatGPT-style chat page with a story reply, a phishing-like email, a Reddit-like thread,
a product-review page) under .../scratchpad/personas/<your-persona>/pages/, and you may visit
real public websites (e.g. Wikipedia, a news site). Do not log into anything. Never touch the
user's own Chrome or any window you didn't launch; don't use the claude-in-chrome tools.

## What to do
1. Write the persona in detail (≈250 words): background, goals, context of use, tech comfort,
   vocabulary, fears, patience, what "success" means to them, and what would make them
   uninstall.
2. Walk through the ACTUAL UI in character, step by step, taking a screenshot at each meaningful
   step (keep them small, JPEG ~80%, max ~1200px wide). Cover: install/first run and consent;
   their real task(s); reading and interpreting results (popup gauge and verdict, breakdown,
   in-page highlights, pill, tooltips, hidden-character markers, image badges); settings/options;
   and at least one edge case relevant to them (very short text, mixed human/AI page, a page with
   no text, an AI story, an image without signals).
3. For each step, record in first person: what they expected, what they saw, what they
   understood or misunderstood, how they felt, and time/effort.
4. **Copy audit:** list EVERY piece of visible UI text the persona encountered (verbatim, with
   where it appears). Rate each: KEEP / CUT / REWORD (give the rewrite, in plain words at the
   persona's reading level) / MOVE-BEHIND-DETAILS. Be ruthless about verbosity, jargon
   (perplexity, logits, C2PA, calibration, q8, WebGPU…), hedging, and repetition.
5. Judge the PLANNED T9 changes (presence modes: On click / Badge / Status chip / Inspector /
   Side panel; entry points; chat-site adapters; battery saver) and T7 (Fusion, agreement
   indicator): which would this persona use, which default they'd want, and what's missing.
6. Findings: helped / hindered / confused / missing, each with severity (blocker / major /
   minor / polish) and a concrete fix. Note accessibility issues you notice (contrast, focus,
   keyboard, screen-reader labels, colour-only signals).

## Output
Write ONE file: /Users/fred/random_stuff/ai_detector/docs/ux/personas/<persona-slug>.md, with
screenshots in docs/ux/shots/<persona-slug>/ (reference them relatively; total ≤ 3 MB). Commit
ONLY those paths locally (`git add <those paths>`, never -A; retry on index.lock), with a message
ending in:
Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Never push, never run gh, and don't edit any other files (other agents are working in the
repo). Close your browser and fixture server when done.

Final reply (under 250 words): the top 5 findings (severity + fix), the 5 worst pieces of UI
copy with rewrites, and this persona's preferred Presence default.
