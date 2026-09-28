# Chrome Web Store: submission record

Everything the Chrome Web Store dashboard asks for, kept current as the code changes.
**Keep this file in sync whenever a permission, host, content-script match, data flow or
listing claim changes** (the built `.output/chrome-mv3/manifest.json` is the source of truth).

| Item | Where |
|---|---|
| Listing text (short + long description, category) | [store/chrome-web-store.md](store/chrome-web-store.md) |
| Permission justifications (paste into "Permissions justification") | [store/permissions.md](store/permissions.md) |
| Single-purpose statement | [store/permissions.md#single-purpose-statement-chrome-web-store](store/permissions.md#single-purpose-statement-chrome-web-store) |
| Data usage form: declare **no data collected** | [store/permissions.md#data-usage-disclosures-chrome-web-store-data-collection-form](store/permissions.md#data-usage-disclosures-chrome-web-store-data-collection-form) |
| Privacy policy URL | https://github.com/freddygaffey/local-ai-detector/blob/main/PRIVACY.md |
| Homepage / support URL | https://github.com/freddygaffey/local-ai-detector |
| Screenshots / promo tiles | [docs/screenshots/](docs/screenshots/), [store/promo/](store/promo/) |
| Publishing steps | [docs/release.md](docs/release.md) |
| Firefox (AMO) listing | [store/amo-listing.md](store/amo-listing.md) |

## Current manifest (Chrome build, v0.2.0)

- **permissions:** `storage`, `activeTab`, `scripting`, `contextMenus`, `alarms`, `offscreen`, `sidePanel`
- **host_permissions (fetch only):** `https://huggingface.co/*`, `https://*.hf.co/*` (text models);
  `https://github.com/*`, `https://release-assets.githubusercontent.com/*` (voice model from the
  `models-v1` release, sha256-verified)
- **optional_host_permissions:** `<all_urls>`, granted per site on click, for image provenance checks; if granted for all sites, also used to add the content script to already-open tabs after an update
- **content_scripts:** `<all_urls>`, for the local Quick check and chip. Causes the install warning
  "Read and change all your data on all websites".
- **content_scripts (page world):** `*://www.youtube.com/*`, `*://m.youtube.com/*`, `world: MAIN`,
  `document_start`. Reads the current video's captions through YouTube's own player so the
  transcript check works (YouTube no longer serves caption files to plain requests). Talks only
  to youtube.com, uses no extension APIs, and restores the viewer's caption settings afterwards.
  No new permission or install warning (already covered by `<all_urls>`).
- **commands:** analyze-page, analyze-selection, toggle-visibility (defaults Alt+Shift+A/S/V; Control+Shift+A/S/V on macOS)
- **CSP:** `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` (WASM bundled, no remote code)

## Review risks to expect

- **Broad site access** (content script on `<all_urls>`): justified by the automatic local
  check. Expect a longer review; the justification is in store/permissions.md.
- **Large runtime downloads** (models from Hugging Face and GitHub): these are data, not code.
  All executable code (JS and WASM) ships in the package.

## Pre-submission checklist

- [ ] Version bumped (package.json and CHANGELOG)
- [ ] `npm run package` green (CI does this on every push)
- [ ] This file matches the built manifest (permissions, hosts, matches)
- [ ] PRIVACY.md lists every network destination
- [ ] Screenshots current
