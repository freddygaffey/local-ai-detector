# Release process

This is a manual, step-by-step guide for **you**, the maintainer, to publish
a release yourself. Nothing in this repository submits, signs, or uploads
anything automatically — every command below that touches the Chrome Web
Store or AMO is something you run yourself, using your own developer
accounts and API keys. Treat every command in this file as something to copy
into your own terminal, not something already run for you.

## 1. Decide the version, and bump it

Versions follow [semver](https://semver.org/): `MAJOR.MINOR.PATCH`.

1. Edit `"version"` in [`package.json`](../package.json). This is the single
   source of truth — `wxt` reads it into both manifests (`manifest.json`
   `version`), and `scripts/package.mjs` uses it to name the release zips.
2. Add a new `## [x.y.z] — YYYY-MM-DD` section to the top of
   [`CHANGELOG.md`](../CHANGELOG.md), above the previous release, describing
   what changed. Keep the "Known limitations" pattern from the 0.1.0 entry —
   this project's whole ethos is an honest accuracy story, not a marketing
   one.
3. Commit both:
   ```sh
   git add package.json CHANGELOG.md
   git commit -m "Release v$(node -p "require('./package.json').version")"
   ```
4. Tag it (optional, but recommended so a release always maps to an exact
   commit):
   ```sh
   git tag "v$(node -p "require('./package.json').version")"
   ```

**Firefox's AMO will reject re-uploading the same version number**, so this
step matters even for a resubmission after a review rejection — bump the
patch version and resubmit.

## 2. Build and verify

```sh
npm ci
npm run package
```

This single command (`scripts/package.mjs`) does everything before you touch
either store:

1. Typechecks and runs the full unit-test suite.
2. Builds both browser targets from a clean `.output/`.
3. Runs `web-ext lint` on the Firefox build and fails on anything beyond the
   two vendored-code warnings already reviewed in [`qa.md`](qa.md).
4. Zips `release/local-ai-detector-<version>-chrome.zip`,
   `-firefox.zip`, and `-sources.zip` (the AMO source submission, with
   [`../BUILD_FROM_SOURCE.md`](../BUILD_FROM_SOURCE.md) included so a
   reviewer — or you, six months from now — can reproduce the build).
5. Verifies none of the three zips contain a source map, a `.env` file, or
   `node_modules`, and that both manifests are Manifest V3 with the Firefox
   one carrying a `gecko` id and `data_collection_permissions`.
6. Prints each zip's size and SHA-256, and writes `release/SHA256SUMS`.
7. Extracts the sources zip into a scratch directory, rebuilds the Firefox
   target from it, and diffs the result against the just-built
   `.output/firefox-mv3` byte-for-byte (skip with `SKIP_REBUILD_CHECK=1` for
   a faster iteration loop; don't skip it before an actual release).

Read the full console output once. If it ends with `package: OK`, you have
three files in `release/` ready to hand to each store — nothing further to
build.

### Reproducibility

The Node/npm versions used to build a release are pinned in
[`../.nvmrc`](../.nvmrc) and `engines` in [`package.json`](../package.json),
so anyone — a Mozilla reviewer, a contributor, future you — can reproduce
the exact build. `npm run package`'s last step already does this check for
the Firefox target on every release: for v0.1.0 it came back **byte-identical
— 33/33 files, same SHA-256 hashes** for every file in `.output/firefox-mv3`,
rebuilt fresh from `release/local-ai-detector-0.1.0-sources.zip`.

**Known non-determinism:** none observed so far. The one caveat is that this
check reuses the already-installed `node_modules/` rather than re-running
`npm ci` against the npm registry, so it proves the *source tree plus a given
`node_modules`* rebuilds deterministically — not that `npm ci` itself is
perfectly reproducible over the network (that's what the committed
`package-lock.json` is for; a full `npm ci && npm run build:firefox` from the
sources zip, as a real reviewer would run, is documented in
[`../BUILD_FROM_SOURCE.md`](../BUILD_FROM_SOURCE.md)). If a future release's
rebuild check ever finds a diff, `npm run package`'s output lists the exact
files and fails loudly — record what caused it here before releasing.

## 3. Publish to the Chrome Web Store

**One-time setup**, if you haven't already:

1. Register as a Chrome Web Store developer at
   <https://chrome.google.com/webstore/devconsole> (Google account, one-time
   **US$5** registration fee).
2. Have the listing text ready: [`store/chrome-web-store.md`](../store/chrome-web-store.md)
   (short/long description, category, single-purpose statement) and
   [`store/permissions.md`](../store/permissions.md) (justification for each
   permission, and the "does not collect data" declaration — copy these
   verbatim into the Developer Dashboard's corresponding fields). Screenshots
   are in [`docs/screenshots/`](screenshots/); promo tile specs and sources
   are in [`store/promo/`](../store/promo/).

**Every release:**

1. Go to the Developer Dashboard → your item (or "New item" the first time).
2. Upload `release/local-ai-detector-<version>-chrome.zip`.
3. Fill in / confirm the store listing fields from
   `store/chrome-web-store.md` and the permission justifications and data-use
   declaration from `store/permissions.md`.
4. Upload the promo images from `store/promo/` (small tile 440×280 required;
   marquee 1400×560 optional — see that folder's README for exact specs and
   how to regenerate them).
5. Submit for review. Google's review typically takes hours to a few days;
   watch your developer-account email.

This project runs no CI/CD pipeline that talks to Google — every upload
above is a manual step in the dashboard's web UI, or via the
[Chrome Web Store publish API](https://developer.chrome.com/docs/webstore/using-api)
if you set that up yourself later.

## 4. Publish to addons.mozilla.org (AMO)

AMO offers two distinct paths. **Listed** puts your add-on on
addons.mozilla.org for anyone to find and install, with a required human/
automated review. **Unlisted** skips the public listing entirely — useful if
you just want a signed `.xpi` you (or people you send a link to) can install
without flipping Firefox's signature-enforcement preference.

**One-time setup:**

1. Create a Firefox Account and go to
   <https://addons.mozilla.org/developers/> to register as an add-on
   developer (free).
2. Generate your own API credentials at
   <https://addons.mozilla.org/developers/addon/api/key/> (a JWT issuer +
   secret). **Keep the secret out of this repository** — export it as
   environment variables in your own shell, never commit it:
   ```sh
   export WEB_EXT_API_KEY="your-jwt-issuer"
   export WEB_EXT_API_SECRET="your-jwt-secret"
   ```

### Option A — Listed (public AMO listing)

1. Have the listing text ready: [`store/amo-listing.md`](../store/amo-listing.md)
   and the permission justifications in
   [`store/permissions.md`](../store/permissions.md).
2. Go to <https://addons.mozilla.org/developers/addon/submit/listed> and
   upload `release/local-ai-detector-<version>-firefox.zip`.
3. When AMO asks for the source code (it will — the extension bundles
   built/minified JS and WASM, which always triggers a source request),
   upload `release/local-ai-detector-<version>-sources.zip`. It contains
   [`BUILD_FROM_SOURCE.md`](../BUILD_FROM_SOURCE.md) with exact,
   reviewer-reproducible build instructions and the pinned Node/npm
   versions.
4. Fill in the listing fields, confirm the permission justifications, and
   confirm `data_collection_permissions: none` matches your actual practice
   (it does — see [`PRIVACY.md`](../PRIVACY.md)).
5. Submit for review. AMO's human review for an extension bundling WASM and
   minified JS can take longer than an average review — budget for that,
   and watch your developer-account email for reviewer questions.

### Option B — Unlisted (self-signed, no public listing)

Use this if you just want a Mozilla-signed `.xpi` for yourself or people you
share a direct link with, without going through public listing/review at the
same bar (unlisted submissions still get an automated/manual review, but
there's no public AMO page).

```sh
npx web-ext sign \
  --source-dir .output/firefox-mv3 \
  --channel unlisted \
  --api-key "$WEB_EXT_API_KEY" \
  --api-secret "$WEB_EXT_API_SECRET"
```

This uploads the build, waits for Mozilla's signing, and downloads the
signed `.xpi` into `.output/` (`web-ext sign`'s own default output
directory, `web-ext-artifacts/`, unless overridden with `--artifacts-dir`).
Install the resulting signed `.xpi` in **any** Firefox channel, including
regular release, by dragging it into a Firefox window or via
`about:addons` → gear icon → "Install Add-on From File…" — no
`xpinstall.signatures.required` flag needed, since it's now genuinely signed.

### Sign an unlisted build for your own use

Same command as above — this **is** that command. If you only ever want a
permanently-installable build for yourself (not a public listing at all),
Option B is the entire process: build (`npm run build:firefox`), sign
(the command above), install the resulting `.xpi`. This is also what
[`docs/install.md`](install.md#option-b--sign-it-yourself-with-your-own-mozilla-account-works-on-any-firefox)
points to.

## 5. After publishing

- Note the assigned Chrome Web Store item ID and/or the AMO add-on slug
  somewhere durable (they don't change between releases).
- Once AMO assigns a permanent add-on ID different from the placeholder
  (`local-ai-detector@freddygaffey.github.io` in
  [`../wxt.config.ts`](../wxt.config.ts)), update `browser_specific_settings.gecko.id`
  there to match, so future uploads are recognized as updates to the same
  add-on rather than a new one.
- Tag the commit if you didn't already (`git tag vX.Y.Z`), and keep
  `release/` (or re-run `npm run package`) so the exact uploaded bytes are
  reproducible later.

## What this project deliberately does *not* automate

Per this project's rules: no command here is run by an agent or by CI on
your behalf, and nothing pushes to a store automatically. `git push` to your
own GitHub remote and any `gh` command are entirely separate from
publishing to a browser store and are your call, made manually, every time.
