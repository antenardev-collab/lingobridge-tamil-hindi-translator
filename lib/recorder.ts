import type { MicErrorKind } from "./i18n";
import { floatToInt16, encodeWav } from "./wav";

/**
 * Persistent ("warm") capture engine for Slice 3+. Instead of acquiring the mic
 * and AudioContext per turn and tearing them down after, it keeps ONE MediaStream
 * + AudioContext + worklet graph alive across turns. The graph never idles, so
 * there is no per-turn acquisition wake cost — the mic is already live when the
 * user acts on the OS touch-down haptic (which is Android's, not ours; we have no
 * navigator.vibrate to move). This kills the ~200 ms leading-speech loss seen
 * on-device after an idle gap.
 *
 * Frames arrive from the worklet continuously. We accumulate them only while a
 * turn is recording and drop them otherwise — the discard path retains nothing,
 * so idle frames cannot accumulate into a slow leak.
 *
 * Acquire lazily on the first user interaction (ensureWarm from a pointerdown),
 * never at page load — autoplay policy would leave the context suspended. One
 * engine is shared by both halves; only one turn records at a time.
 *
 * getUserMedia constraints are unchanged from Slice 1 (echoCancellation +
 * noiseSuppression); AGC/NS parity remains parked.
 */

const SAMPLE_RATE = 16000;
const WORKLET_URL = "/worklets/pcm-recorder.js";

/**
 * Minimum captured duration for a turn to be sent. Below this, a release is
 * treated as an accidental press, not speech, and the audio is discarded
 * before encoding — never sent to /api/translate. 300ms sits far above an
 * accidental press (the 92ms incident that motivated this gate) and far below
 * any real word, including short affirmatives like ஆமா / சரி / हाँ.
 * Deliberately conservative: it must only ever catch accidents, never speech.
 */
const MIN_TURN_MS = 300;
const MIN_TURN_SAMPLES = Math.round((MIN_TURN_MS / 1000) * SAMPLE_RATE);

/**
 * Minimum RMS loudness for a turn to be sent, in dBFS. Below this, a release
 * cleared the duration gate (so it's a real, deliberate press) but captured
 * only room noise, not speech — the 4b.2 duration gate can't catch this
 * because the audio duration is legitimate; only loudness distinguishes it.
 *
 * Derivation (PLAN.md 4b.2 calibration, do not casually retune): Android
 * phone steady-state background noise measured at -46.8 dBFS RMS (video
 * playing, people talking); quietest phone speech -20.0 dBFS. Desktop
 * background ceiling -56.9 dBFS; quietest desktop speech -44.3 dBFS. -42
 * sits 4.8 dB above the phone noise ceiling — deliberately biased toward the
 * noise floor, because gating real speech is a worse failure than passing a
 * fabrication through to the model.
 */
const MIN_TURN_RMS_DBFS = -42;

/**
 * TEMPORARY measurement instrumentation for the 4b.2 energy-gate decision
 * (PLAN.md): the duration gate above catches accidental taps but not a
 * genuine press capturing room noise/silence, which the model still
 * fabricates a plausible sentence from. This computes RMS + peak amplitude
 * from the captured samples so real on-device numbers can inform whether an
 * energy threshold exists at all, before any gate is built on top of it.
 * Measurement only — nothing here blocks or alters what gets sent. Remove or
 * promote into an actual gate once a threshold decision is made; do not let
 * this linger past that decision.
 */
const SILENCE_FLOOR_DBFS = -100;

/** 20*log10(value), clamped to SILENCE_FLOOR_DBFS so true silence (0) and any
 * non-positive input never produce -Infinity or NaN. */
function toDbfs(value: number): number {
  if (value <= 0) return SILENCE_FLOOR_DBFS;
  const db = 20 * Math.log10(value);
  return db < SILENCE_FLOOR_DBFS ? SILENCE_FLOOR_DBFS : db;
}

export interface AmplitudeReading {
  rmsLinear: number;
  rmsDbfs: number;
  peakLinear: number;
  peakDbfs: number;
}

/** RMS and peak absolute amplitude over the full capture, linear [0,1] + dBFS. */
function measureAmplitude(samples: Float32Array): AmplitudeReading {
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSquares += s * s;
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
  }
  const rms = samples.length ? Math.sqrt(sumSquares / samples.length) : 0;
  return {
    rmsLinear: rms,
    rmsDbfs: toDbfs(rms),
    peakLinear: peak,
    peakDbfs: toDbfs(peak),
  };
}

/** Distinguishes permission denial from a generic capture failure. */
export class RecorderError extends Error {
  kind: MicErrorKind;
  constructor(kind: MicErrorKind, cause?: unknown) {
    super(kind);
    this.name = "RecorderError";
    this.kind = kind;
    this.cause = cause;
  }
}

export interface Recording {
  /** audio/wav — canonical 44-byte header + 16 kHz mono PCM16. */
  blob: Blob;
  /** Always "audio/wav"; kept so callers/session memory keep a stable shape. */
  mimeType: string;
  /** Wall-clock capture duration (independent of sample count) for the implied-rate readout. */
  durationSec: number;
  /** TEMPORARY — see the measureAmplitude comment above. 4b.2 energy-gate measurement only. */
  amplitude: AmplitudeReading;
}

/**
 * Returned by stopRecording instead of a Recording when either insufficiency
 * check trips: duration (too few samples — likely an accidental press) or
 * energy (enough samples, but too quiet — likely room noise, not speech).
 * Both checks gate the SAME turn shape; `reason` records which one fired.
 * Duration is checked first, so a turn failing duration is always recorded
 * as "duration" even if its RMS is also below MIN_TURN_RMS_DBFS — an energy
 * verdict is only meaningful once there was enough audio to measure.
 */
export interface GatedTurn {
  gated: true;
  /** Which check tripped. */
  reason: "duration" | "energy";
  /** Captured sample count at SAMPLE_RATE — the evidence for a duration trip. */
  samples: number;
  /** Sample count converted to ms, for a human-readable debug readout. */
  impliedMs: number;
  /** Measured RMS dBFS — set only when `reason` is "energy", so a threshold
   * that turns out wrong is diagnosable from the export rather than guesswork. */
  rmsDbfs?: number;
}

export class CaptureEngine {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;

  private recording = false;
  private chunks: Float32Array[] = [];
  private startedAt = 0;
  private onFirstFrame: (() => void) | null = null;

  // Ownership token for the active turn. startRecording hands one out; only a
  // stopRecording carrying the matching token may end and claim the audio. This
  // is what makes simultaneous holds safe: the second (non-owning) side gets null
  // and cannot start, truncate, or walk off with the first speaker's audio under
  // its own sourceLang. Monotonic so a laggy release can't stop a newer turn.
  private turnToken = 0;
  private activeToken: number | null = null;

  // Set when the OS revokes the stream or the context dies (e.g. on backgrounding).
  // The next ensureWarm then fully re-acquires rather than capturing silence.
  private needsReacquire = false;
  private warming: Promise<void> | null = null;

  /**
   * Ensure a live, running capture graph. Idempotent; safe to call on every
   * pointerdown, and MUST be called from within a user gesture (so resume() and
   * getUserMedia are permitted). Repairs a suspended context (resume) or a
   * revoked stream / closed context (full re-acquire). Concurrent calls share
   * one in-flight acquisition.
   */
  async ensureWarm(): Promise<void> {
    if (this.warming) return this.warming;
    this.warming = this.doEnsureWarm().finally(() => {
      this.warming = null;
    });
    return this.warming;
  }

  private async doEnsureWarm(): Promise<void> {
    const trackLive =
      !!this.stream && this.stream.getAudioTracks().some((t) => t.readyState === "live");
    const ctxDead = !this.ctx || this.ctx.state === "closed";
    if (this.needsReacquire || ctxDead || !this.node || !trackLive) {
      await this.teardown();
      await this.acquire();
      this.needsReacquire = false;
      return;
    }
    // Healthy graph but the OS may have suspended it on backgrounding — resume.
    if (this.ctx && this.ctx.state !== "running") {
      try {
        await this.ctx.resume();
      } catch {
        // Left non-running; the next tap retries. Better than capturing silence.
      }
    }
  }

  private async acquire(): Promise<void> {
    let ctx: AudioContext;
    try {
      const AC: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AC({ sampleRate: SAMPLE_RATE });
    } catch (err) {
      throw new RecorderError("unavailable", err);
    }
    this.ctx = ctx;
    ctx.onstatechange = () => {
      if (this.ctx && this.ctx.state === "closed") this.needsReacquire = true;
    };
    try {
      await ctx.resume();
    } catch {
      // A suspended context produces no frames; surfaced as a late/short clip.
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      await this.teardown();
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new RecorderError("denied", err);
      }
      throw new RecorderError("unavailable", err);
    }
    this.stream = stream;
    // If the OS revokes the mic (backgrounding, another app grabbing it), flag
    // for re-acquire so we never sit on a dead track thinking it is warm.
    for (const t of stream.getAudioTracks()) {
      t.onended = () => {
        this.needsReacquire = true;
      };
    }

    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      const node = new AudioWorkletNode(ctx, "pcm-recorder", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      this.node = node;
      node.port.onmessage = (e: MessageEvent) => {
        // Continuous frames. Drop unless a turn is recording — retain nothing
        // when idle, so discarded frames cannot accumulate.
        if (!this.recording) return;
        this.chunks.push(e.data as Float32Array);
        if (this.onFirstFrame) {
          const cb = this.onFirstFrame;
          this.onFirstFrame = null;
          cb();
        }
      };
      const source = ctx.createMediaStreamSource(stream);
      this.source = source;
      source.connect(node);
      // Keep process() pulled; the worklet's output is silent, so no feedback.
      node.connect(ctx.destination);
    } catch (err) {
      await this.teardown();
      throw new RecorderError("unavailable", err);
    }
  }

  /** True while a turn is being captured. */
  isRecording(): boolean {
    return this.recording;
  }

  /**
   * Begin accumulating frames for one turn. Returns an ownership token, or null
   * if the engine is already recording another side's turn (the caller must then
   * treat itself as not recording — never show a recording state it didn't get).
   * `onFirstFrame` fires on the first frame that actually arrives after this call
   * — the real readiness signal the UI gates its recording state on (instant when
   * warm, visibly late if warming ever regresses: a free detector for the
   * front-loss bug).
   */
  startRecording(onFirstFrame: () => void): number | null {
    if (this.recording) return null;
    const token = ++this.turnToken;
    this.activeToken = token;
    this.chunks = [];
    this.onFirstFrame = onFirstFrame;
    this.recording = true;
    this.startedAt = performance.now();
    return token;
  }

  /**
   * End the turn owned by `token`. Returns the WAV + wall-clock duration, or null
   * if `token` doesn't own the active recording (a non-owning side, or a stale
   * release) or no turn is in progress (released during warm-up).
   */
  async stopRecording(token: number): Promise<Recording | GatedTurn | null> {
    if (!this.recording || token !== this.activeToken) return null;
    const durationSec = this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0;
    this.recording = false;
    this.activeToken = null;
    this.onFirstFrame = null;
    const chunks = this.chunks;
    this.chunks = [];
    this.startedAt = 0;

    let total = 0;
    for (const c of chunks) total += c.length;

    // Gate 1 — duration: an accidental press never reaches floatToInt16/
    // encodeWav, let alone the network. Checked before energy so a low-RMS
    // accidental tap is recorded as a duration trip, not an energy trip.
    if (total < MIN_TURN_SAMPLES) {
      return {
        gated: true,
        reason: "duration",
        samples: total,
        impliedMs: Math.round((total / SAMPLE_RATE) * 1000),
      };
    }

    const samples = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
      samples.set(c, offset);
      offset += c.length;
    }

    // Measured from the Float32 samples themselves — before encoding, not
    // read back from the WAV bytes. Feeds gate 2 below and the exported
    // amplitude readout (lib/types.ts) on turns that pass both gates.
    const amplitude = measureAmplitude(samples);

    // Gate 2 — energy: a genuine, deliberate press that cleared the duration
    // gate but captured only room noise. The model still returns a
    // confident, plausible fabrication with no error signal, so this must
    // not reach the network either. See MIN_TURN_RMS_DBFS derivation above.
    if (amplitude.rmsDbfs < MIN_TURN_RMS_DBFS) {
      return {
        gated: true,
        reason: "energy",
        samples: total,
        impliedMs: Math.round((total / SAMPLE_RATE) * 1000),
        rmsDbfs: amplitude.rmsDbfs,
      };
    }

    const pcm = floatToInt16(samples);
    const wav = encodeWav(pcm, SAMPLE_RATE);
    return {
      blob: new Blob([wav], { type: "audio/wav" }),
      mimeType: "audio/wav",
      durationSec,
      amplitude,
    };
  }

  /** Full teardown — stops the mic and closes the context. For unmount. */
  async dispose(): Promise<void> {
    this.recording = false;
    this.activeToken = null;
    this.onFirstFrame = null;
    this.chunks = [];
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    try {
      this.source?.disconnect();
    } catch {
      /* already gone */
    }
    if (this.node) {
      this.node.port.onmessage = null;
      try {
        this.node.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    if (this.ctx) {
      this.ctx.onstatechange = null;
      if (this.ctx.state !== "closed") {
        try {
          await this.ctx.close();
        } catch {
          /* already closing */
        }
      }
    }
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }
}
