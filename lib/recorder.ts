import type { MicErrorKind } from "./i18n";
import { floatToInt16, encodeWav } from "./wav";

/**
 * Live capture for Slice 3+. Replaces the Slice 1 MediaRecorder (which produced
 * webm/opus on Android Chrome — rejected by both providers' inline-audio APIs)
 * with a client-side AudioWorklet that yields 16 kHz mono PCM16 WAV, matching
 * the PCM format of test-clips/*.wav. There is ONE capture path, not two behind
 * a flag.
 *
 * Mechanism: an AudioContext requested at 16000 Hz (Android Chrome honours this
 * and resamples at the graph boundary — verified on-device) → mic source node →
 * pcm-recorder worklet, which posts Float32 frames. On stop we concatenate,
 * convert to Int16 and write the WAV header (lib/wav.ts). getUserMedia keeps the
 * Slice 1 constraints (echoCancellation + noiseSuppression) unchanged.
 */

const SAMPLE_RATE = 16000;
const WORKLET_URL = "/worklets/pcm-recorder.js";

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
  /** Always "audio/wav" now; kept so callers/session memory keep a stable shape. */
  mimeType: string;
  /**
   * Wall-clock capture duration in seconds, measured independently of the sample
   * count. This is what lets the UI compute an implied sample rate that would
   * expose a worklet silently running at 48k — a sample-derived duration couldn't.
   */
  durationSec: number;
}

/**
 * A single hold-to-talk session. `start` is called from the pointerdown handler
 * so the AudioContext is created and resumed inside the user gesture — autoplay
 * policy leaves it suspended otherwise, and that failure is silent. `stop` tears
 * the graph down and closes the context so the OS mic indicator clears.
 */
export class MicRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private startedAt = 0;

  async start(): Promise<void> {
    // Create + resume the context first, synchronously within the gesture.
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
    try {
      await ctx.resume();
    } catch {
      // A suspended context still produces no frames; surfaced later as 0 bytes.
    }

    // getUserMedia constraints unchanged from Slice 1 (AGC/NS parity is a
    // separate open question, not this step's).
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

    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      const node = new AudioWorkletNode(ctx, "pcm-recorder", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      this.node = node;
      this.chunks = [];
      node.port.onmessage = (e: MessageEvent) => {
        // One render quantum of mono Float32, buffer transferred to us.
        this.chunks.push(e.data as Float32Array);
      };

      const source = ctx.createMediaStreamSource(stream);
      this.source = source;
      source.connect(node);
      // Connect to destination to keep process() pulled; output stays silent.
      node.connect(ctx.destination);
    } catch (err) {
      await this.teardown();
      throw new RecorderError("unavailable", err);
    }

    this.startedAt = performance.now();
  }

  /** Resolves with the captured WAV + wall-clock duration. Safe to call once per start. */
  async stop(): Promise<Recording> {
    const durationSec = this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0;
    const chunks = this.chunks;
    this.chunks = [];
    // Detach the graph and close the context first so the mic indicator clears.
    await this.teardown();

    let total = 0;
    for (const c of chunks) total += c.length;
    const samples = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
      samples.set(c, offset);
      offset += c.length;
    }

    const pcm = floatToInt16(samples);
    const wav = encodeWav(pcm, SAMPLE_RATE);
    return {
      blob: new Blob([wav], { type: "audio/wav" }),
      mimeType: "audio/wav",
      durationSec,
    };
  }

  private async teardown(): Promise<void> {
    try {
      this.source?.disconnect();
    } catch {
      /* already gone */
    }
    try {
      this.node?.disconnect();
    } catch {
      /* already gone */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== "closed") {
      try {
        await this.ctx.close();
      } catch {
        /* already closing */
      }
    }
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    this.startedAt = 0;
  }
}
