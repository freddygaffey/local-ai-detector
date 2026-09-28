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
  C -- click --> P[Panel: flagged items ▲▼,<br/>highlights toggle, Deep ↻,<br/>highlight by: All / one detector, Settings, ×]
  C -- drag --> W[Moved: remembered for this site<br/>Use everywhere / Reset in the panel]
  H2[Highlighted sentence] -- click --> T2[Its score + per-detector lines<br/>Esc / scroll / click away closes]
  P -- Deep ↻ --> D[All detectors, whole page/transcript,<br/>voice Thorough] --> C
  P -- "× / Esc" --> C
```

## 3. Video (YouTube)

```mermaid
flowchart TD
  V[Watch page / Short] --> T[Transcript: player's caption track<br/>via page-world API]
  V --> A[Voice: read-only copy of the audio segments the player downloads<br/>page-world tap, UMP audio parts → decoded at original speed<br/>fallback: the played audio, only at 0.75–2×]
  A --> S[Sample 2 portions → Spectra-AASIST3]
  T --> Q[Quick score, timestamps]
  S --> R[Voice score]
  Q --> K[Card: Script n% / Voice n%<br/>+ inline chips under title<br/>+ YouTube's own synthetic label]
  R --> K
  X[Never changes playback speed,<br/>captions prefs or other extensions' state] -.-> V
```

### Other sites' videos

```mermaid
flowchart LR
  P[Any video starts playing with sound<br/>Voice mode: Auto on any video] --> C[Played audio via captureStream<br/>at 0.75–2× only]
  C --> S[Spectra-AASIST3] --> K[Voice chip + card]
```

## 4. Popup opens

```mermaid
flowchart TD
  O[Popup opens on tab<br/>232px, never blocked by inference:<br/>models run in Workers] --> R{Readable?}
  R -- no --> Q[One quiet line]
  R -- yes --> S[Ask the page for the card state]
  S --> K{Already checked?}
  K -- yes --> L[Score + verdict + tier tag<br/>Quick / Deep check running… / Deep, · saved if remembered.<br/>Primary: Deep check / Check again]
  K -- no --> N[Primary: Check page]
  L --> X[Details ▸: breakdown, mode/style, page type, site rule, paste]
  O --> P[⏸ → pause automatic checks 1 / 5 / 12 h<br/>Paused until … · Resume]
```

## 4b. Manual check (popup, context menu, shortcut)

```mermaid
flowchart TD
  M[User asks for a check] --> C{Same text + setup<br/>remembered?}
  C -- yes --> D[Show it at once, tagged saved]
  C -- no --> Q[Quick pass → shown at once,<br/>tagged Deep check running…]
  Q --> G{Deep models downloaded?}
  G -- no --> S[Quick stands; Deep check offers the download]
  G -- yes --> P[Deep pass over the top<br/>Quick stays on show]
  P -- Cancel deep check --> X[Worker torn down, Quick stands]
  P --> R[Deep result replaces it, remembered]
  M -- selection --> B[Result bubble above the selection's top-left]
  M -- nothing selected --> T[Toast: No text selected]
```

## 5. First run

```mermaid
flowchart LR
  I[Install] --> C[Popup: model checklist, all ticked, sizes + total]
  C -- Download & enable --> D[Progress per model] --> R[Ready: auto Quick checks begin]
```
