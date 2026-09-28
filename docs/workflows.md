# Intended workflows

What the extension is supposed to do, as flows. Every change is checked against these, and the
daily-driver tour (docs/daily-driver-tour.md) exercises each one. If behaviour and diagram
disagree, one of them is a bug.

## 1. Any page loads

```mermaid
flowchart TD
  A[Page loads / SPA navigates] --> B{Readable?}
  B -- "PDF, chrome://, store, blocked" --> P[Nothing on page.<br/>Popup: one quiet line.<br/>Right-click selected text still works]
  B -- yes --> C[Classify page type<br/>URL rules → fingerprinting]
  C --> D{Type}
  D -- article --> E[Quick check on main text<br/>TMR, ≤1024 tokens]
  D -- thread --> F[Per-item Quick scores<br/>comments / posts / reviews]
  D -- video --> G[Transcript + voice<br/>see flow 3]
  D -- subtitles --> H[Transcript-style scoring]
  D -- search --> I[Snippet markers only]
  D -- "app / off" --> J[Nothing automatic]
  E --> K{Quick ≥ 50%?}
  K -- yes --> L[Confirm with Fusion]
  K -- no --> M
  L --> M[Corner card updates]
  F --> M
  G --> M
  H --> M
  I --> M
  M --> N[Card: always present, thumbnail-sized,<br/>clear of other corner widgets]
```

## 2. Corner card interaction

```mermaid
flowchart LR
  C[Collapsed card<br/>AI 12% / 3 AI of 24 /<br/>Script 23% · Voice 7%<br/>+ CR/WM/U+ markers] -- hover or focus --> H[Hover card:<br/>per-signal verdicts, page type + why,<br/>n/m agree, Quick/Deep, device]
  C -- click --> P[Panel: flagged items ▲▼,<br/>highlights toggle, Deep ↻,<br/>per-detector numbers, Settings, ×]
  P -- Deep ↻ --> D[All detectors, whole page/transcript,<br/>voice Thorough] --> C
  P -- "× / Esc" --> C
```

## 3. Video (YouTube)

```mermaid
flowchart TD
  V[Watch page / Short] --> T[Transcript: player's caption track<br/>via page-world API]
  V --> A[Voice: audio segments YouTube already downloaded<br/>decoded at 1× regardless of playback speed]
  A --> S[Sample 2 portions → Spectra-AASIST3]
  T --> Q[Quick score, timestamps]
  S --> R[Voice score]
  Q --> K[Card: Script n% / Voice n%<br/>+ inline chips under title<br/>+ YouTube's own synthetic label]
  R --> K
  X[Never changes playback speed,<br/>captions prefs or other extensions' state] -.-> V
```

## 4. Popup opens

```mermaid
flowchart TD
  O[Popup opens on tab] --> R{Readable?}
  R -- no --> Q[One quiet line]
  R -- yes --> S[Ask the page for the card state]
  S --> K{Already checked?}
  K -- yes --> L[Lead with the result, same as the card.<br/>Primary button: Deep check]
  K -- running --> M[Progress]
  K -- no --> N[Primary button: Check page]
  L --> X[Secondary: selection, paste, mode, page type, site memory]
```

## 5. First run

```mermaid
flowchart LR
  I[Install] --> C[Popup: model checklist, all ticked, sizes + total]
  C -- Download & enable --> D[Progress per model] --> R[Ready: auto Quick checks begin]
```
