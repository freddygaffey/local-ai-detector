// Private wire protocol for the voice check (T11). Its own `kind` strings,
// so it never collides with src/shared/messages.ts or the engine host
// protocol, and adding it needed no change to either shared contract.
//
//   content  --lad-voice-->       background  (score one clip / query status)
//   background --lad-voice-host--> offscreen doc (Chrome) / voice worker (Firefox)
//   host --lad-voice-progress--> background --> the requesting tab

import type { VoiceModelId } from "./aggregate";

export type VoiceOp = "score" | "status";

export interface VoiceRequest {
  kind: "lad-voice";
  op: VoiceOp;
  model: VoiceModelId;
  /** 16 kHz mono PCM as little-endian Int16, base64 ("score" only). */
  pcmB64?: string;
}

export type VoiceResponse =
  | { ok: true; margin?: number; ms?: number; device?: string; cached?: boolean }
  | { ok: false; error: string; code?: "consent" | "disabled" | "integrity" | "failed" };

export interface VoiceHostRequest {
  kind: "lad-voice-host";
  id: string;
  op: VoiceOp;
  model: VoiceModelId;
  pcmB64?: string;
  allowWebGPU: boolean;
}

export interface VoiceProgress {
  kind: "lad-voice-progress";
  id?: string;
  loaded: number;
  total: number;
}

export const isVoiceRequest = (m: unknown): m is VoiceRequest =>
  !!m && typeof m === "object" && (m as { kind?: unknown }).kind === "lad-voice";
export const isVoiceHostRequest = (m: unknown): m is VoiceHostRequest =>
  !!m && typeof m === "object" && (m as { kind?: unknown }).kind === "lad-voice-host";
export const isVoiceProgress = (m: unknown): m is VoiceProgress =>
  !!m && typeof m === "object" && (m as { kind?: unknown }).kind === "lad-voice-progress";

export function encodePcm(x: Float32Array): string {
  const i16 = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(x[i]! * 32767)));
  const bytes = new Uint8Array(i16.buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decodePcm(b64: string): Float32Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i]! / 32767;
  return out;
}
