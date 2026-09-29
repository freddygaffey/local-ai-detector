// Voice-check capture for one <video> (T11). Only hears what is playing:
// `captureStream()` (Firefox: `mozCaptureStream()` as a fallback) into a
// 16 kHz AudioContext, which resamples natively in both browsers. Never
// seeks, never fetches the media separately, never changes playback.
//
// Sampling is a RATE over watched playback (./schedule.ts), speech-gated
// (./vad.ts). Each accepted clip is sent to the background for scoring and
// folded into a running trimmed mean (./aggregate.ts).
//
// Failure modes all end in status "unavailable" (the UI shows "—", never an
// error): captureStream throwing (cross-origin without CORS in Chrome), a
// digitally silent track (the same case in Firefox, or DRM/EME media), or no
// audio track at all.

import { CLIP_SAMPLES, RETRY_S, SAMPLE_RATE, nextClipDelay, noRoomForClip, type VoiceRate } from "./schedule";
import { speechGate } from "./vad";
import { aggregate, clipProbability, type VoiceAggregate, type VoiceClip, type VoiceModelId, type VoiceSensitivity } from "./aggregate";
import { encodePcm, type VoiceResponse } from "./protocol";

export type VoiceStatus = "starting" | "listening" | "downloading" | "unavailable" | "consent" | "error" | "stopped";

export interface VoiceState {
  status: VoiceStatus;
  clips: VoiceClip[];
  agg: VoiceAggregate;
  /** Download progress 0..1 while status is "downloading". */
  download?: number;
  device?: string;
  msPerClip?: number;
  durationS: number;
}

export interface VoiceSessionOptions {
  rate: VoiceRate;
  batterySaver: boolean;
  model: VoiceModelId;
  sensitivity: VoiceSensitivity;
  score(pcmB64: string): Promise<VoiceResponse>;
  /** True while the audio shouldn't be sampled (e.g. a YouTube ad is playing). */
  skip?(): boolean;
  /**
   * Original-speed audio for a clip at this playback position (YouTube's own
   * downloaded audio, ./sourceAudio.ts), or null to record what is playing.
   */
  source?(atS: number): Promise<Float32Array | null>;
  /** Recording what is playing is allowed right now (the speed is one the detector handles). */
  canRecord?(): boolean;
  onUpdate(state: VoiceState): void;
}

/** Consecutive silent clips (before any speech) after which we give up with "—". */
const MAX_SILENT = 3;

type CapturableVideo = HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };

export class VoiceSession {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private buf = new Float32Array(CLIP_SAMPLES);
  private filled = 0;
  private recording = false;
  private clipStartPos = 0;
  private busy = false;
  private watched = 0;
  private lastTime: number;
  private nextDue = 0;
  private silent = 0;
  private cleanup: (() => void)[] = [];
  readonly state: VoiceState = { status: "starting", clips: [], agg: { p: null, clips: 0 }, durationS: NaN };

  constructor(
    readonly video: HTMLVideoElement,
    private opts: VoiceSessionOptions,
  ) {
    this.lastTime = video.currentTime;
  }

  start(): void {
    // The audio graph is built only when a clip is first recorded, and paused
    // between clips (battery): on YouTube clips normally come from the
    // downloaded audio (`source`), so it usually never runs at all.
    this.on(this.video, "timeupdate", () => this.onTime());
    this.on(this.video, "seeking", () => this.abortClip());
    this.on(this.video, "emptied", () => this.abortClip());
    this.set("listening");
  }

  /** Captures the element's audio on first use. False when it can't be captured. */
  private ensureCapture(): boolean {
    if (this.stream) return true;
    const v = this.video as CapturableVideo;
    try {
      const cap = v.captureStream ?? v.mozCaptureStream;
      if (!cap) {
        this.set("unavailable");
        return false;
      }
      this.stream = cap.call(v);
    } catch {
      this.set("unavailable"); // SecurityError: cross-origin media without CORS
      return false;
    }
    if (this.stream.getAudioTracks().length) this.connect();
    else this.on(this.stream as unknown as EventTarget, "addtrack", () => this.connect());
    return true;
  }

  /** Pause the audio graph between clips (no audio callbacks while idle). */
  private pauseGraph(): void {
    if (this.ctx?.state === "running") void this.ctx.suspend().catch(() => {});
  }

  stop(): void {
    this.set("stopped");
    for (const c of this.cleanup) c();
    this.cleanup = [];
    for (const n of this.nodes) n.disconnect();
    this.nodes = [];
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private on(t: EventTarget, ev: string, fn: () => void): void {
    t.addEventListener(ev, fn);
    this.cleanup.push(() => t.removeEventListener(ev, fn));
  }

  private set(status: VoiceStatus, extra: Partial<VoiceState> = {}): void {
    if (this.state.status === "stopped") return;
    Object.assign(this.state, { status, durationS: this.video.duration }, extra);
    this.opts.onUpdate(this.state);
  }

  private connect(): void {
    if (this.ctx || !this.stream?.getAudioTracks().length) return;
    try {
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      const src = ctx.createMediaStreamSource(this.stream);
      // ScriptProcessor (not AudioWorklet): a worklet module can't be loaded
      // into arbitrary pages under their CSP from a content script.
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0; // must reach the destination to run, but stay silent
      proc.onaudioprocess = (e) => this.onAudio(e.inputBuffer.getChannelData(0));
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      this.ctx = ctx;
      this.nodes = [src, proc, mute];
      if (ctx.state === "suspended") {
        // Autoplay policy: resume on the next user gesture on the page.
        const resume = () => void ctx.resume().catch(() => {});
        resume();
        for (const ev of ["pointerdown", "keydown"]) this.on(document, ev, resume);
      }
    } catch {
      this.set("unavailable");
    }
  }

  private onTime(): void {
    const t = this.video.currentTime;
    const dt = t - this.lastTime;
    this.lastTime = t;
    if (this.opts.skip?.()) {
      if (this.recording) this.abortClip();
      return;
    }
    if (dt > 0 && dt < 1.5 && !this.video.seeking) this.watched += dt; // seeks/loops don't count
    if (!this.recording && !this.busy && this.watched >= this.nextDue && this.state.status === "listening") {
      if (noRoomForClip(this.schedState())) return;
      if (this.opts.source) return void this.fromSource(t);
      this.startRecording(t);
    }
  }

  private startRecording(t: number): void {
    if (this.opts.canRecord && !this.opts.canRecord()) return;
    if (!this.ensureCapture()) return;
    if (this.ctx?.state === "suspended") void this.ctx.resume().catch(() => {});
    this.recording = true;
    this.filled = 0;
    this.clipStartPos = t;
  }

  /** A clip from the original audio (any playback speed); falls back to recording. */
  private async fromSource(t: number): Promise<void> {
    this.busy = true;
    let x: Float32Array | null = null;
    try {
      x = (await this.opts.source?.(t)) ?? null;
    } catch {
      x = null;
    }
    this.busy = false;
    if (this.state.status === "stopped") return; // a newer session took over while decoding
    if (x) return this.finishClip(x, t);
    this.startRecording(t);
  }

  private abortClip(): void {
    this.recording = false; // never stitch audio across a seek or source change
    this.filled = 0;
    this.lastTime = this.video.currentTime;
    this.pauseGraph();
  }

  private onAudio(x: Float32Array): void {
    if (!this.recording || this.video.paused || this.video.seeking) return;
    if (this.opts.skip?.()) return this.abortClip();
    const n = Math.min(x.length, CLIP_SAMPLES - this.filled);
    this.buf.set(x.subarray(0, n), this.filled);
    this.filled += n;
    if (this.filled >= CLIP_SAMPLES) {
      this.recording = false;
      this.pauseGraph();
      void this.finishClip(this.buf.slice(), this.clipStartPos);
    }
  }

  private schedState() {
    return { watchedS: this.watched, clips: this.state.clips.length, positionS: this.video.currentTime, durationS: this.video.duration };
  }

  private async finishClip(x: Float32Array, atS: number): Promise<void> {
    const gate = speechGate(x);
    if (!gate.ok) {
      if (gate.reason === "silent" && this.state.clips.length === 0 && ++this.silent >= MAX_SILENT) return this.set("unavailable");
      this.nextDue = this.watched + RETRY_S;
      return;
    }
    this.silent = 0;
    this.busy = true;
    try {
      const res = await this.opts.score(encodePcm(x));
      if (!res.ok) {
        if (res.code === "consent") return this.set("consent");
        if (res.code === "disabled") return this.stop();
        return this.set("error");
      }
      const p = clipProbability(res.margin ?? 0, this.opts.model, this.opts.sensitivity);
      this.state.clips.push({ atS, p });
      this.state.agg = aggregate(this.state.clips);
      this.nextDue = this.watched + nextClipDelay(this.schedState(), this.opts.rate, this.opts.batterySaver);
      this.set("listening", { device: res.device, msPerClip: res.ms, download: undefined });
    } catch {
      this.set("error");
    } finally {
      this.busy = false;
    }
  }

  /** Download progress from the background (first clip only). */
  onDownload(loaded: number, total: number): void {
    if (this.state.status === "listening" || this.state.status === "downloading") {
      this.set(loaded >= total ? "listening" : "downloading", { download: total ? loaded / total : 0 });
    }
  }
}
