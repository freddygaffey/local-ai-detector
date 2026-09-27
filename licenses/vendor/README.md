# Vendored licence texts

`onnxruntime-web` and `c2pa-text`, at the exact versions pinned in
[`package.json`](../../package.json), do not include a `LICENSE` file in their
published npm tarball (verified: `ls node_modules/<pkg>` has no `LICENSE*`).
Both are MIT per their `package.json` `license` field and their public GitHub
repository. This folder holds the real upstream licence text, fetched
directly from GitHub at the commit/tag that matches the installed version, so
[`scripts/copy-vendor-assets.mjs`](../../scripts/copy-vendor-assets.mjs) can
ship a genuine licence file instead of a placeholder. That script fails the
build if a bundled dependency has neither an npm-shipped licence file nor an
entry here.

| Folder | Package | Installed version | Source | Fetched from |
|---|---|---|---|---|
| `onnxruntime-web/` | `onnxruntime-web` 1.31.0-dev.20260914-8d85527a0 | dev prerelease | [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) | Exact commit `8d85527a010e294a26b274749f74294b2a32cec5` (decoded from the npm version string's `20260914-8d85527a0` build tag and confirmed via the GitHub commits API) — [`LICENSE`](https://github.com/microsoft/onnxruntime/blob/8d85527a010e294a26b274749f74294b2a32cec5/LICENSE), [`ThirdPartyNotices.txt`](https://github.com/microsoft/onnxruntime/blob/8d85527a010e294a26b274749f74294b2a32cec5/ThirdPartyNotices.txt) |
| `c2pa-text/` | `c2pa-text` 3.0.0 | 3.0.0 | [encypherai/c2pa-text](https://github.com/encypherai/c2pa-text) | Tag `v3.0.0` (commit `4f45274f8647f98451f7fbe89c8b5fa03cce5929`) — [`LICENSE`](https://github.com/encypherai/c2pa-text/blob/v3.0.0/LICENSE) |

Both are plain MIT licences (Microsoft Corporation; Encypher Corporation).
`onnxruntime-web`'s `ThirdPartyNotices.txt` additionally covers the
third-party native code (WASM SIMD backend, etc.) it bundles internally; it is
shipped alongside the MIT licence as
`public/licenses/onnxruntime-web.ThirdPartyNotices.txt`.

If a future `npm install` bumps either package to a version whose licence
text differs, re-fetch it from the matching upstream commit/tag and replace
the file here — do not assume the text is still current.
