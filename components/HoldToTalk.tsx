"use client";

import { useRef, useState } from "react";
import { CaptureEngine, RecorderError, type Recording } from "@/lib/recorder";
import { strings, forSide, type MicErrorKind } from "@/lib/i18n";
import type { Side } from "@/lib/types";

interface HoldToTalkProps {
  side: Side;
  /** Shared warm capture engine (one mic/context for both halves). */
  engine: CaptureEngine;
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
export default function HoldToTalk({ side, engine, onCapture, onError, onStart }: HoldToTalkProps) {
  const [recording, setRecording] = useState(false);
  // Guards against a stop firing before warm-up resolves, or two stops racing.
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
    try {
      // Warm (or repair) the shared graph inside this gesture, then start the
      // turn. When already warm this returns immediately.
      await engine.ensureWarm();
      if (!activeRef.current) {
        // Released during warm-up — never started a turn, nothing to discard.
        return;
      }
      // Gate the visual recording state on the FIRST real frame, not on warm-up
      // resolving: instant when warm, a visible lag if warming ever regresses.
      engine.startRecording(() => {
        if (activeRef.current) setRecording(true);
      });
    } catch (err) {
      activeRef.current = false;
      setRecording(false);
      if (err instanceof RecorderError) onError(err.kind);
      else onError("unavailable");
    }
  }

  async function end() {
    if (!activeRef.current) return;
    activeRef.current = false;
    setRecording(false);
    try {
      const rec = await engine.stopRecording();
      // null means the turn never actually began (released during warm-up).
      if (rec) onCapture(rec);
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
