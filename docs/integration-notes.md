# Integration notes for T5 (collected by the lead from task reports)

## From T0
- `onnxruntime-web` and `c2pa-text` ship without LICENSE files. public/licenses/ has placeholders; T6 must fetch the real text.
- `modelOverrides` is `Partial<Record<ModelSlot,…>>`.

## From T4 (provenance)
- The provenance background creates the offscreen doc itself and tolerates T1 doing so concurrently. Merge this with T1's offscreen client.
- c2pa-web 0.15.2 rejects non-https worker URLs, so T4 passes a stand-in URL object pointing at the packaged worker. **Unverified in a real browser**, so test this first.
- T2's clear / SPA cleanup must call `clearImageBadges()` (T2 has been told).
- T3 should use `UNCHECKABLE_SCHEMES` (src/provenance/schemes.ts) and `requestImagePermission()` (permissions.ts, must be called from a user gesture).
- C2PA text manifests: the signature and signer are verified, but not that the manifest is bound to the text. The UI says so.
- The Interim Trust List is not bundled because its licence is unclear.
- DWT-DCT detection adds a vote-agreement test on top of the Hamming check, because upstream's own decoder gets 5–20% of bits wrong on small images.
