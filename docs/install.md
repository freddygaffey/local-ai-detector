# Install

There is no published Chrome Web Store or AMO listing yet (the maintainer
publishes those themselves — see [`release.md`](release.md)). Until then,
this is the only way to install Local AI Detector: build it and load it
yourself. This is normal for open-source browser extensions and takes a few
minutes.

## For end users (no development tools beyond Node.js)

### 1. Get the code and build it

```sh
git clone https://github.com/freddygaffey/ai_detector.git local-ai-detector
cd local-ai-detector
npm ci
npm run build            # Chrome/Edge/Brave -> .output/chrome-mv3
npm run build:firefox    # Firefox -> .output/firefox-mv3
```

You need [Node.js](https://nodejs.org/) — see [`../.nvmrc`](../.nvmrc) and
`engines` in [`../package.json`](../package.json) for the tested version
range (Node 22–25). `npm ci` also downloads nothing beyond the npm packages
themselves; the extension's own model downloads only happen the first time
you use it, after you consent in the popup.

Prebuilt release zips (once a release exists) are under
[`release/`](../release/) after running `npm run package`, or attached to a
GitHub release — you can skip the build step and use those instead if you
trust a prebuilt binary; everything below still applies to the unpacked
`.output/*-mv3` folder either way (unzip the release zip first).

### 2. Load it — Chrome, Edge, Brave, or any other Chromium browser

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `.output/chrome-mv3` folder (not a zip — the folder itself).
5. The toolbar icon appears immediately. Click it, then "Download & enable"
   to fetch the default models (~211 MB) the first time you analyze a page.

To update after pulling new source: `npm run build` again, then click the
reload icon on the extension's card in `chrome://extensions`. Chrome
sometimes keeps the old service worker cached across reloads during active
development — if something looks stale, remove and re-load the unpacked
extension.

### 3. Load it — Firefox (temporary, until you restart Firefox)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select any file *inside* `.output/firefox-mv3` (e.g. its `manifest.json`).
4. The toolbar icon appears immediately.

**This temporary install is removed every time Firefox restarts.** You'll
need to repeat these three steps after every restart, or use one of the two
permanent options below.

### 4. Load it permanently in Firefox

Regular release Firefox only runs add-ons Mozilla has signed, and this
project doesn't auto-submit anything for signing (see
[`release.md`](release.md) — that's a manual step for whoever publishes it).
Two ways around that if you built it yourself:

**Option A — Firefox Developer Edition or Nightly (easiest, no signing needed)**

1. Install [Firefox Developer Edition](https://www.mozilla.org/firefox/developer/)
   or [Firefox Nightly](https://www.mozilla.org/firefox/channel/desktop/#nightly)
   (regular release/Beta Firefox refuses this setting).
2. Go to `about:config`, accept the warning, search for
   `xpinstall.signatures.required`, and set it to `false`.
3. Go to `about:addons` → the gear icon → **Install Add-on From File…** and
   pick a **zipped** build. Build one with:
   ```sh
   npx wxt zip -b firefox
   ```
   which produces `.output/local-ai-detector-<version>-firefox.zip`. Select
   that zip (not the unpacked folder — this install path needs the zip).
4. It now survives restarts, like any other add-on, and updates the same way
   (rebuild → re-zip → reinstall over it, or use `about:debugging`'s
   temporary-add-on flow during development instead).

This only works on Developer Edition/Nightly/ESR-unbranded builds; regular
release and Beta Firefox enforce signature checks unconditionally and will
refuse to install even with this preference set.

**Option B — sign it yourself with your own Mozilla account (works on any Firefox)**

Mozilla's `web-ext sign` produces a Mozilla-signed `.xpi` you can install on
any Firefox channel, using **your own** free Mozilla Add-on Developer Hub API
credentials — this is a publishing step, so it's documented (commands only,
nothing run automatically) in
[`release.md`](release.md#sign-an-unlisted-build-for-your-own-use).

## For developers

```sh
npm ci
npm run dev              # Chrome, dev mode with hot reload
npm run dev:firefox      # Firefox, dev mode
npm test                 # vitest — 220+ unit tests
npm run typecheck
```

`npm run dev`/`dev:firefox` open a real browser instance (via WXT) with the
extension loaded and hot-reloading; you don't need to manually reload after
most source changes. See [`README.md`](../README.md#build-from-source) for
the full command list, and [`../docs/plan.md`](plan.md) /
[`../docs/feasibility.md`](feasibility.md) for the architecture and design
rationale.

## Troubleshooting

- **"Manifest file is missing or unreadable"** — you selected the repo root
  or a zip file instead of the built `.output/chrome-mv3` /
  `.output/firefox-mv3` folder (or, for Firefox's file picker, a file
  *inside* it). Run `npm run build` / `npm run build:firefox` first.
- **Models won't download** — check Options → the engine info line for the
  current device/thread count, and confirm you have network access to
  `huggingface.co`. See [`PRIVACY.md`](../PRIVACY.md) for exactly what's
  fetched and when. Corporate proxies/firewalls that block `huggingface.co`
  will prevent the first-run download entirely.
- **Firefox: temporary add-on disappeared** — this is expected; see
  "Load it permanently" above.
- **Chrome: changes don't show up after rebuilding** — reload the unpacked
  extension's card in `chrome://extensions` (service workers can be cached
  across a plain file overwrite during active development).
- Anything else: check [`docs/qa.md`](qa.md) for known issues found during
  testing, or open an issue with your browser/OS and the Options → engine
  info line.
