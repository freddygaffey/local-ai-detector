// The voice chip (T11): "Voice: AI 72% · 14 clips". On YouTube it sits right
// after T10's transcript chip (or under the title); elsewhere in a fixed
// corner. Clicking starts the check (on-click mode), else toggles Details: a
// small per-clip timeline (where the voice changes, e.g. a human intro then
// AI narration; click a tick to seek) and one line of technical detail.
// Closed shadow DOM. The lead may later merge this into the transcript chip.

import { scoreColor } from "../content/colors";
import { visibleVideoTitle } from "../content/youtube/ui";
import { formatVoice } from "./aggregate";
import type { VoiceState } from "./capture";
import { VOICE_MODELS } from "../engine/voiceModels";
import { formatBytes } from "../ui/format";
import type { VoiceSettings } from "./settings";

export interface VoiceChipCallbacks {
  onRun(): void;
  onSeek(seconds: number): void;
  /** Model download not consented to yet ("consent" state): grants it and retries. */
  onConsent(): void;
}

export interface VoiceChipApi {
  setState(state: VoiceState | null, meta: { settings: VoiceSettings; rate: string }): void;
  remount(): void;
  destroy(): void;
}

function theme(): "light" | "dark" {
  try {
    if (document.documentElement.hasAttribute("dark")) return "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Chip text for a state; null state = not started. Pure (tested). */
export function voiceLabel(s: VoiceState | null): { text: string; muted: boolean; score?: number } {
  if (!s) return { text: "Voice", muted: true };
  switch (s.status) {
    case "starting":
      return { text: "Voice…", muted: true };
    case "downloading":
      return { text: `Voice: model ${Math.round((s.download ?? 0) * 100)}%`, muted: true };
    case "unavailable":
    case "error":
    case "consent":
      return { text: "Voice: —", muted: true };
    default: {
      if (s.agg.p === null) return { text: formatVoice(s.agg), muted: true };
      return { text: formatVoice(s.agg), muted: false, score: s.agg.p };
    }
  }
}

export function formatClock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const CSS = `
  :host { all: initial; display: inline-block; vertical-align: top; }
  * { box-sizing: border-box; }
  .wrap { font: 12px/1.3 Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 6px 0 2px; }
  .chip { font: inherit; font-weight: 600; cursor: pointer; border-radius: 999px; padding: 3px 10px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
  .chip.muted { color: var(--muted); font-weight: 500; }
  .chip:hover, .chip:focus-visible { border-color: var(--fg); outline: none; }
  .action { font: inherit; font-weight: 600; cursor: pointer; border-radius: 999px; padding: 4px 12px;
    border: 1px solid var(--link); background: var(--bg); color: var(--link); }
  .action:hover, .action:focus-visible { background: var(--link); color: var(--bg); outline: none; }
  .details { margin-top: 6px; width: min(560px, 90vw); border: 1px solid var(--line); border-radius: 10px; padding: 8px;
    background: var(--bg); color: var(--fg); }
  .details[hidden] { display: none; }
  .tl { position: relative; height: 18px; border-radius: 4px; background: var(--track); }
  .tick { position: absolute; top: 2px; width: 6px; height: 14px; margin-left: -3px; border: 0; padding: 0;
    border-radius: 2px; cursor: pointer; }
  .tick:focus-visible { outline: 2px solid var(--fg); }
  .axis { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; margin-top: 2px;
    font-variant-numeric: tabular-nums; }
  .meta { margin-top: 6px; color: var(--muted); font-size: 11px; }
  :host { --bg: #fff; --fg: #0f0f0f; --muted: #606060; --line: rgba(0,0,0,0.15); --track: rgba(0,0,0,0.06); --link: #065fd4; }
  :host(.dark) { --bg: #212121; --fg: #f1f1f1; --muted: #aaa; --line: rgba(255,255,255,0.2); --track: rgba(255,255,255,0.08); --link: #3ea6ff; }
`;

function anchor(): Element | null {
  const t = document.querySelector("ai-detector-transcript");
  if (t && t.getClientRects().length && !(t as HTMLElement).style.position) return t;
  return visibleVideoTitle();
}

export function createVoiceChip(cb: VoiceChipCallbacks, opts: { fixedOnly?: boolean } = {}): VoiceChipApi {
  const host = document.createElement("ai-detector-voice");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = CSS;
  const wrap = document.createElement("div");
  wrap.className = "wrap";
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip muted";
  const details = document.createElement("div");
  details.className = "details";
  details.hidden = true;
  wrap.append(chip, details);
  shadow.append(style, wrap);

  let state: VoiceState | null = null;
  let meta: { settings: VoiceSettings; rate: string } | null = null;

  const place = () => {
    host.classList.toggle("dark", theme() === "dark");
    const a = opts.fixedOnly ? null : anchor();
    if (a) {
      host.style.cssText = "";
      if (a.nextElementSibling !== host) a.after(host);
    } else {
      host.style.cssText = "position:fixed; left:12px; bottom:48px; z-index:2147482000;";
      if (host.parentElement !== document.body) document.body.appendChild(host);
    }
  };

  const renderDetails = () => {
    details.replaceChildren();
    if (!state) return;
    if (state.status === "consent") {
      const bytes = meta ? VOICE_MODELS[meta.settings.model].bytes : undefined;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "action";
      btn.textContent = bytes !== undefined ? `Download model (${formatBytes(bytes)})` : "Download model";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        cb.onConsent();
      });
      const note = document.createElement("div");
      note.className = "meta";
      note.textContent = "Needed once, on-device; nothing leaves this device.";
      details.append(btn, note);
      return;
    }
    const clips = state.clips;
    const dur = Number.isFinite(state.durationS) && state.durationS > 0 ? state.durationS : Math.max(1, ...clips.map((c) => c.atS + 4));
    const tl = document.createElement("div");
    tl.className = "tl";
    for (const c of clips) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tick";
      b.style.left = `${Math.min(100, (c.atS / dur) * 100)}%`;
      b.style.background = scoreColor(c.p, theme());
      b.title = `${formatClock(c.atS)} · AI ${Math.round(c.p * 100)}%`;
      b.setAttribute("aria-label", b.title);
      b.addEventListener("click", () => cb.onSeek(c.atS));
      tl.append(b);
    }
    const axis = document.createElement("div");
    axis.className = "axis";
    axis.append(formatClock(0), formatClock(dur));
    const m = document.createElement("div");
    m.className = "meta";
    const parts = [
      meta ? VOICE_MODELS[meta.settings.model].label.replace(" (voice)", "") : "",
      meta ? meta.settings.sensitivity : "",
      meta ? `${meta.rate} rate` : "",
      state.device && state.msPerClip !== undefined ? `${state.device} ${state.msPerClip} ms/clip` : "",
      state.status === "unavailable" ? "no audio (cross-origin, DRM or silent)" : "",
      "experimental; misses some AI voices, esp. with music; probability, not proof",
    ].filter(Boolean);
    m.textContent = parts.join(" · ");
    details.append(tl, axis, m);
  };

  const render = () => {
    const l = voiceLabel(state);
    chip.textContent = l.text;
    chip.classList.toggle("muted", l.muted);
    chip.style.color = l.score !== undefined ? scoreColor(l.score, theme()) : "";
    // Needing consent isn't a state a click should have to uncover: show the
    // download action up front (never a silent "Voice: --" with no way on).
    if (state?.status === "consent") details.hidden = false;
    chip.setAttribute(
      "aria-label",
      state?.status === "consent" ? `${l.text}. Model download needs your consent.` : state ? `${l.text}. Show voice timeline.` : "Check the voice for AI speech",
    );
    renderDetails();
  };

  chip.addEventListener("click", () => {
    if (!state || state.status === "stopped") return cb.onRun();
    if (state.status === "consent") return; // the action is already visible in Details
    details.hidden = !details.hidden;
  });

  place();
  render();

  return {
    setState(s, m) {
      state = s;
      meta = m;
      render();
    },
    remount: place,
    destroy() {
      host.remove();
    },
  };
}
