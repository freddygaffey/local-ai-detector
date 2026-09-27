# Local AI Detector

A free, open-source (MIT), fully local AI-content detector browser extension
for Chrome and Firefox (MV3). Everything — text classification, perplexity /
burstiness, Binoculars, hidden-Unicode scanning, and image provenance checks —
runs on-device. No servers, no API keys, no cost. Models download once from
Hugging Face and are cached locally.

See [docs/plan.md](docs/plan.md) and [docs/feasibility.md](docs/feasibility.md)
for the design and research behind this project.

## Status

Early scaffold (T0). Most functionality is stubbed out; see the task table in
`docs/plan.md` for what's implemented and what's still TODO.

## Development

```sh
npm install
npm run dev          # Chrome, dev mode
npm run dev:firefox  # Firefox, dev mode
npm run build         # Chrome production build -> .output/chrome-mv3
npm run build:firefox # Firefox production build -> .output/firefox-mv3
npm run zip           # Chrome store zip
npm run zip:firefox   # Firefox store + sources zip
npm test               # vitest
npm run typecheck
```

This README is a stub; T6 will expand it with an honest accuracy section,
privacy notes, and store listing text.
