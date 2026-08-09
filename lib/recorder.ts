import type { MicErrorKind } from "./i18n";

/**
 * MediaRecorder wrapper for Slice 1 capture.
 *
 * - Requests audio with echoCancellation + noiseSuppression (CLAUDE.md stack).
 * - Picks a supported container at runtime because Android Chrome and iOS
 *   Safari disagree on what MediaRecorder accepts. The chosen mimeType is
 *   returned with the blob so Slice 2 can send the right content type.
 */

/** Candidate containers, most-preferred first. */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

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

/** First container this browser's MediaRecorder actually supports, or "" for default. */
function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

export interface Recording {
  blob: Blob;
  mimeType: string;
}

/**
 * A single hold-to-talk session. Construct on pointerdown via `start`, then
 * call `stop` on pointerup/pointercancel to get the blob. The underlying
 * MediaStream is torn down on stop so the OS mic indicator clears between turns.
 */
export class MicRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = "";

  async start(): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new RecorderError("denied", err);
      }
      throw new RecorderError("unavailable", err);
    }

    this.stream = stream;
    this.mimeType = pickMimeType();
    this.chunks = [];

    try {
      this.recorder = this.mimeType
        ? new MediaRecorder(stream, { mimeType: this.mimeType })
        : new MediaRecorder(stream);
    } catch (err) {
      this.teardown();
      throw new RecorderError("unavailable", err);
    }

    // If we fell back to the browser default, record what it actually chose.
    if (!this.mimeType) this.mimeType = this.recorder.mimeType || "";

    this.recorder.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    });

    this.recorder.start();
  }

  /** Resolves with the captured blob + its container. Safe to call once per start. */
  stop(): Promise<Recording> {
    return new Promise((resolve, reject) => {
      const recorder = this.recorder;
      if (!recorder) {
        reject(new RecorderError("unavailable"));
        return;
      }
      if (recorder.state === "inactive") {
        // Never started or already stopped — assemble whatever we have.
        const type = this.mimeType || "audio/webm";
        resolve({ blob: new Blob(this.chunks, { type }), mimeType: type });
        this.teardown();
        return;
      }
      recorder.addEventListener(
        "stop",
        () => {
          const type = this.mimeType || recorder.mimeType || "audio/webm";
          const blob = new Blob(this.chunks, { type });
          this.teardown();
          resolve({ blob, mimeType: type });
        },
        { once: true },
      );
      recorder.stop();
    });
  }

  private teardown(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }
}
