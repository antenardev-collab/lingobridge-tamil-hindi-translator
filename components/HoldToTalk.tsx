"use client";

import { useRef, useState } from "react";
import { MicRecorder, RecorderError, type Recording } from "@/lib/recorder";
import { strings, forSide, type MicErrorKind } from "@/lib/i18n";
import type { Side } from "@/lib/types";

interface HoldToTalkProps {
  side: Side;
  onCapture: (rec: Recording) => void;
  onError: (kind: MicErrorKind) => void;
  /** Called when a recording starts so the parent can clear a stale error. */
  onStart?: () => void;
}

/**
 * Large hold-to-talk button used by both halves.
 *
 * Mechanism is pointer capture: on pointerdown we capture the pointer to this
 * element, so every later pointer event (including a finger sliding off the
 * button) retargets here. We therefore stop on pointerup + pointercancel only —
 * no pointerleave, which with capture active either won't fire on touch or
 * would misfire mid-drag on a desktop mouse and cut the recording early.
 */
export default function HoldToTalk({ side, onCapture, onError, onStart }: HoldToTalkProps) {
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MicRecorder | null>(null);
  // Guards against a stop firing before start resolves, or two stops racing.
  const activeRef = useRef(false);

  async function begin(e: React.PointerEvent<HTMLButtonElement>) {
    if (activeRef.current) return;
    activeRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is best-effort; pointerup still fires without it.
    }
    onStart?.();
    const recorder = new MicRecorder();
    recorderRef.current = recorder;
    try {
      await recorder.start();
      if (!activeRef.current) {
        // Released before the mic came up — discard immediately.
        await recorder.stop().catch(() => {});
        recorderRef.current = null;
        return;
      }
      setRecording(true);
    } catch (err) {
      activeRef.current = false;
      recorderRef.current = null;
      setRecording(false);
      if (err instanceof RecorderError) onError(err.kind);
      else onError("unavailable");
    }
  }

  async function end() {
    if (!activeRef.current) return;
    activeRef.current = false;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    if (!recorder) return;
    try {
      const rec = await recorder.stop();
      // Always report — a 0-byte blob must be visible on screen so a bad
      // mimeType shows up as "0 B" per the PLAN's done-when for this slice.
      onCapture(rec);
    } catch (err) {
      if (err instanceof RecorderError) onError(err.kind);
      else onError("unavailable");
    }
  }

  return (
    <button
      type="button"
      className={`hold-btn${recording ? " recording" : ""}`}
      onPointerDown={begin}
      onPointerUp={end}
      onPointerCancel={end}
      aria-pressed={recording}
    >
      {forSide(recording ? strings.recording : strings.holdToTalk, side)}
    </button>
  );
}
