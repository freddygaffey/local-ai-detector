# Store listing assets

Everything needed to submit this extension to the Chrome Web Store and AMO,
gathered in one place so publishing (see [`../docs/release.md`](../docs/release.md))
is copy-paste rather than re-writing listing text under deadline.

| File | What |
|---|---|
| [`chrome-web-store.md`](chrome-web-store.md) | Chrome Web Store: category, short/long description, single-purpose statement |
| [`amo-listing.md`](amo-listing.md) | addons.mozilla.org: category, summary/full description, source-submission note |
| [`permissions.md`](permissions.md) | Shared by both: per-permission justification, single-purpose statement, data-usage disclosures |
| [`promo/`](promo/) | Chrome Web Store promo tiles (440×280, 1400×560), PNG + editable SVG source |
| [`icon/`](icon/) | Icon SVG sources and extra light/dark PNG variants (the shipped manifest icons are `../public/icon/*.png`) |

Screenshots for both listings live in
[`../docs/screenshots/`](../docs/screenshots/) (owned by the QA/integration
task, not duplicated here).

None of this directory is bundled into the extension package — it's
publishing collateral only. `npm run package` never reads from `store/`.
