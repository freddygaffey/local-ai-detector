# Permission justifications

Line-by-line justification of every permission in the built `manifest.json`
(both browsers), for the Chrome Web Store and AMO listing "permission
justification" fields. See [`wxt.config.ts`](../wxt.config.ts) for the source
of truth and [`PRIVACY.md`](../PRIVACY.md) for the full network-request
accounting these permissions enable.

## Required permissions

| Permission | Why | What it does *not* do |
|---|---|---|
| `storage` | Persists your settings (mode, highlight style, thresholds, model choices) and the "consented to download" flag, via `storage.sync`/`storage.local`. | No data is sent anywhere; this is local/browser-synced storage only, never read by us. |
| `activeTab` | Lets the toolbar-button click and the right-click "Check selected text" menu act on the page you're currently viewing, without requesting access to every site up front. | Doesn't grant access to any other tab, and doesn't persist past the click that invoked it. |
| `scripting` | Injects the content script into a tab on demand (e.g. a tab that was already open before the extension was installed, or after "Scan page" from the pill), and re-injects after SPA navigation. | Only runs the extension's own bundled content script, never arbitrary code, and only in response to a user action. |
| `contextMenus` | Adds the right-click menu entries: "Check selected text for AI writing", "Analyze this page for AI writing", "Check image for Content Credentials & watermarks" (image context), and "Check text in this box for AI writing" (input/textarea/contenteditable context). | No other use. |
| `sidePanel` (Chrome only) | The optional Side panel Presence: a full report of flagged sentences that follows the active tab. Declared automatically by the build tool (WXT) because the extension ships a side panel page. Firefox uses its own `sidebar_action` manifest key instead, which needs no permission. | The side panel only opens when you pick that Presence (or click the toolbar icon while it's selected); it never opens itself. |
| `commands` (declared, not a runtime permission) | Rebindable keyboard shortcuts: analyze page, analyze selection, toggle visibility. Configurable/removable at `chrome://extensions/shortcuts` (Chrome) or `about:addons` (Firefox). | No other use. |
| `alarms` | A once-a-minute timer that unloads the AI models from memory after the idle period set under Battery saver (default 5 min), so they don't hold RAM when you're not using the extension. | No network activity; it only frees memory. |
| `offscreen` (Chrome only) | Chrome's MV3 service worker cannot create Web Workers or use WebAssembly with SharedArrayBuffer directly, so the ML inference engine (ONNX Runtime Web) and the C2PA validator run inside a hidden offscreen document instead. Firefox uses a regular Worker from its event page instead, so it doesn't need this permission. | The offscreen document has no UI, isn't visible, and isn't a general-purpose page — it only runs the bundled inference/C2PA code. |
| `host_permissions`: `https://huggingface.co/*`, `https://*.hf.co/*` | Downloads model weights (and, when you ask, checks for newer versions) directly from Hugging Face, and follows their CDN's `*.hf.co` redirect for the actual file bytes. Together with the GitHub model-download hosts below, these are the only hosts the extension *fetches* from. | No model download happens until you explicitly click "Download & enable" on first use (or "Update"/"Check for updates" later); nothing else is fetched from these hosts. |
| `host_permissions`: `https://github.com/*`, `https://release-assets.githubusercontent.com/*` | Downloads the one experimental voice-check model file (int8 ONNX) from this project's GitHub Release, following GitHub's redirect to its asset host for the bytes. GitHub sends no CORS headers, so the extension needs host access to read the response. | Only that model download, only after download consent and while the voice check is on; size and sha256 are verified. No page, audio or other data is sent. |

## Content script on all sites (`content_scripts.matches: ["<all_urls>"]`)

The extension's own bundled content script runs on every page so the default Quick check can read the page's visible text **locally** and show the unobtrusive score chip without a click. The same script handles the comment/thread and YouTube adapters. This is why Chrome shows *"Read and change all your data on all websites"* at install.

| What it does | What it does *not* do |
|---|---|
| Reads visible text, and on YouTube the transcript and short audio clips of the playing video, and hands them to the on-device engine in the extension. Draws the chip, highlights and badges. | Never sends page text, audio, URLs or browsing history anywhere. No fetches to page origins (images need the optional permission below). Auto-run can be turned off (Presence → Auto-run: Never) or limited per site. |

## Optional permission

| Permission | Why | What it does *not* do |
|---|---|---|
| `optional_host_permissions`: `<all_urls>` | Lets the extension fetch **one image's bytes** to check it for C2PA Content Credentials, generator metadata, or an invisible watermark — but **only for an origin you've explicitly granted**, one site at a time, via the "Allow image checks on `<site>`" button in the popup. At install, this permission is granted for **zero** sites. | Never used for page text (that's read directly from the DOM by the content script, no fetch/host permission involved), never granted automatically, never requested without a visible browser permission prompt tied to a click. Turning off "Check images" in Options stops this feature from asking at all. |

## Content Security Policy

`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` — the strictest CSP
MV3 allows that still lets the bundled ONNX Runtime Web WASM run
(`'wasm-unsafe-eval'` is required for WebAssembly, not for `eval()` of
strings; no remote script source is ever allowed).

## Single-purpose statement (Chrome Web Store)

Local AI Detector's single purpose is to analyze the text and images on the
page a user is viewing, entirely on-device, for signs of AI generation
(text-classifier scoring, hidden Unicode characters, and image provenance/
watermark signals) and to display that analysis to the user. It does not
sync data to a server, run ads, or perform any function unrelated to that
one purpose.

## Data-usage disclosures (Chrome Web Store "Data collection" form)

Per the form's categories: this extension does **not** collect or transmit
any of Personally identifiable information, Health information, Financial
and payment information, Authentication information, Personal
communications, Location, Web history, User activity, or Website content, to
any server operated by the developer or any third party. All processing
happens locally. Declare: **"This developer does not collect or use your
data."**

## Firefox `data_collection_permissions`

`browser_specific_settings.gecko.data_collection_permissions.required` is set
to `["none"]` — matching the above: nothing is collected.
