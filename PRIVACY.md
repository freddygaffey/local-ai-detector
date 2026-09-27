# Privacy policy

**Local AI Detector collects no data, runs no servers, and has no accounts,
analytics, telemetry, or crash reporting of any kind.** Every page you
analyze, every score, every setting, and every cached model stays on your
device. Nothing about you or the pages you read is ever sent to the
developer or to any third party we operate.

This document lists **every** network request the extension can make, exactly
when each one happens, and exactly what it sends. If it isn't listed here, the
extension doesn't do it. This matches the independent network capture in
[`docs/qa.md`](docs/qa.md#network-chrome---log-net-log-whole-browser), which
recorded every host contacted by the extension across a full Chrome and
Firefox test session.

## The only network requests the extension makes

### 1. Downloading and updating AI models — `huggingface.co` and `*.hf.co`

To score text, the extension needs the model weights it doesn't ship (they're
hundreds of megabytes; see [`THIRD_PARTY.md`](THIRD_PARTY.md) for exact
sizes). These are downloaded, once per model, directly from Hugging Face:

- **On first use**, the popup shows a consent screen naming the exact models
  and their download size. **Nothing downloads until you click "Download &
  enable."** If you decline, the extension does nothing over the network.
- **When you click "Check for updates"** in Options (or, if you've explicitly
  turned on the auto-check toggle — **off by default** — periodically in the
  background), it makes one metadata request per model to
  `https://huggingface.co/api/models/<repo>?blobs=true` to read the latest
  commit hash. This does not download any model weights by itself.
- **When you click "Update"** on a model, or enter a **custom model** repo ID
  in Options, the new weights are downloaded the same way as the first-run
  download.
- **The actual model files** (ONNX weights, tokenizer, config) are fetched
  from `https://huggingface.co/<repo>/resolve/<revision>/...`, which
  Hugging Face's CDN may redirect to a `*.hf.co` address (observed:
  `us.aws.cdn.hf.co`) to serve the bytes.

None of these requests carry cookies or credentials (the metadata check
explicitly sets `credentials: "omit"`; the extension runs at its own
`chrome-extension://`/`moz-extension://` origin, so a normal cross-origin
fetch never attaches Hugging Face cookies regardless). The only information
Hugging Face's servers see is what any visitor's request reveals — the model
repo/revision being requested, your IP address, and standard HTTP headers —
the same as opening that URL in a regular tab. See
[Hugging Face's own privacy policy](https://huggingface.co/privacy) for how
they handle that.

Downloaded models are cached locally (the browser's Cache API, with an
IndexedDB fallback) so they aren't re-downloaded. Options → model management
shows the cache size and lets you delete it.

### 1b. Downloading the voice-check model — `github.com` and `release-assets.githubusercontent.com`

The experimental voice check (on by default; listed, ticked, in the same
download checklist as the text models) needs one extra model file, which is
not on Hugging Face. It is downloaded **once**, only after you've consented
to model downloads, from this project's own GitHub Release:
`https://github.com/freddygaffey/local-ai-detector/releases/download/models-v1/<file>.onnx`,
which GitHub redirects to `release-assets.githubusercontent.com` for the
bytes. The request carries no cookies (`credentials: "omit"`). The file's
size and sha256 are checked before it is used. Nothing else is ever fetched
from these hosts, and turning the voice check off stops it.

The audio itself never leaves your device: the check listens to the video
you're playing (`captureStream`, no extra fetch of the media), scores short
clips locally, and discards them.

### 1c. Reading a YouTube transcript — stays on youtube.com, goes nowhere else

To score a video's transcript, a small script running in the YouTube page
itself (`entrypoints/youtube-main.content.ts`, only on `youtube.com`/
`m.youtube.com`) asks the video player for its own caption track, the same
request the player would make if you turned captions on yourself — YouTube
no longer answers a plain caption request without it. This **stays entirely
within youtube.com** (no new host, no extension API used from that script)
and only *reads* caption text that YouTube already serves for the video
you're watching; it fetches nothing else and sends nothing back. The
transcript text and the voice-check's audio are then scored **entirely
locally**, in the same on-device engine as everything else, and never
uploaded or sent anywhere — not to Hugging Face, not to youtube.com, not
anywhere.

### 2. Checking an image's provenance — only for sites you've allowed, and only the image bytes

When "Check images" is on (default: on) and the extension has permission for
an image's origin, it fetches that **one image's bytes** — nothing else on
the page — to check it locally for C2PA Content Credentials, generator
metadata, and open-source invisible watermarks. This is the one case where
the extension talks to a site other than Hugging Face, and it's scoped as
narrowly as the platform allows:

- **No image is fetched without your permission**, checked per-origin,
  every time, before any request: the manifest declares
  `optional_host_permissions: ["<all_urls>"]` — meaning **zero site access is
  granted at install** — and the extension calls
  `browser.permissions.contains(...)` for the image's exact origin
  immediately before fetching. If it isn't granted, the result is
  "permission needed," nothing is fetched, and the popup shows an
  "Allow image checks on `<site>`" button you can click to grant it for that
  site (a real, user-visible browser permission prompt — not silent).
- The fetch omits cookies (`credentials: "omit"`) and reads at most ~25 MB.
- The bytes are decoded and analyzed **entirely locally**, in the same
  on-device engine as text analysis. They are never uploaded anywhere, never
  sent to Hugging Face or anywhere else, and are discarded once the check
  finishes (only the result — e.g. "C2PA: valid, signer X" — is kept, per
  tab, until you navigate away).
- Turning "Check images" off in Options stops this entirely; no image bytes
  are ever fetched.
- The bundled C2PA Trust List and its validator never make network requests
  of their own: remote manifest fetching and OCSP checking are both
  explicitly disabled, so the C2PA check never has to leave your browser.

### 3. The slop filter, search-result markers and site memory add no new network requests

Three T9 features are entirely local, and don't change anything above:

- **Slop filter** (Options → Slop filter, off by default): dims/collapses
  comments, posts and reviews scored by the same on-device engine as the
  rest of the page. The **search-result markers** (Google/Bing/DuckDuckGo/
  Kagi) score only the snippet text already rendered on the results page —
  it **never fetches the linked page**.
- **Site memory** (Options → Site memory, off by default): a local tally per
  domain (e.g. "7 of the last 10 pages scored high"), stored with
  `storage.local`. It records **only** the hostname, a plain high/low flag,
  and a date — **never** page text, URLs, or scores. It's fully visible and
  clearable from Options, and stays on your device like everything else.
- **Chat/comment/thread adapters** and the **"Check text in this box"**
  context menu read text already on the page (or already typed into a box);
  neither one fetches anything.

### 4. Anything else

There isn't anything else. No analytics SDK, no crash/error reporting
service, no update-ping beyond the Hugging Face metadata check above, no
"phone home" of any kind. The extension has no backend of its own —
there is no server operated by this project. The only two remote parties
your browser will ever talk to *because of this extension* are Hugging Face
(models) and, only with your explicit per-site permission, whatever site
hosts an image you asked to be checked.

External links shown in the UI (e.g. "cannot be checked locally — try the
Gemini app" for SynthID, or the AMO/Chrome Web Store install pages) are
plain `<a>` links you have to click yourself; the extension never opens or
fetches them automatically.

## What never leaves your device

- The text of any page you analyze, and every sentence-level score.
- YouTube transcripts and the voice check's audio clips — read/captured and
  scored locally, then discarded.
- All settings (mode, highlight style, thresholds, model choices).
- Cached model weights, once downloaded.
- Image provenance results.
- The site-memory tally (hostname + high/low flag + date only — no text or URLs), if turned on.

All of the above are stored using the browser's own `storage.sync`/
`storage.local` and Cache/IndexedDB APIs — under your browser profile,
subject to your browser's own sync settings (e.g. Chrome Sync or Firefox
Sync, if you have those enabled — that's your browser syncing your own
extension settings across your own devices, not this extension talking to a
server of ours).

## Permissions, and why

See [`store/permissions.md`](store/permissions.md) for the line-by-line
justification of every permission in the built `manifest.json`, written for
the Chrome Web Store and AMO listing forms.

## Changes to this policy

Any change to what data the extension collects or which network requests it
makes will be reflected here and in [`CHANGELOG.md`](CHANGELOG.md) before it
ships in a release.

## Contact

This is a free, open-source hobby project with no company behind it. For
privacy questions, open an issue on the source repository. There is no other
data controller, processor, or support channel.
