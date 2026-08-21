"use client";

import { useRef, useState } from "react";
import { CaptureEngine, RecorderError, type GatedTurn, type Recording } from "@/lib/recorder";
import { strings, forSide, type MicErrorKind } from "@/lib/i18n";
import type { Side } from "@/lib/types";

interface HoldToTalkProps {
  side: Side;
  /** Shared warm capture engine (one mic/context for both halves). */
  engine: CaptureEngine;
  /** `releasedAt` is the pointerup mark (client clock) — the Slice 4a `release`. */
  onCapture: (rec: Recording, releasedAt: number) => void;
  /** Called instead of onCapture when the release was below MIN_TURN_MS — a trip, not a turn. */
  onGated: (gated: GatedTurn) => void;
  onError: (kind: MicErrorKind) => void;
  /** Called when a recording starts so the parent can clear a stale error. */
  onStart?: () => void;
  /**
   * Blocks a NEW hold from starting — checked at pointerdown, before
   * anything else. Does not affect a hold already in progress: see end()'s
   * comment for why a pointer-up is never refused. Defaults to false.
   */
  disabled?: boolean;
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
export default function HoldToTalk({
  side,
  engine,
  onCapture,
  onGated,
  onError,
  onStart,
  disabled = false,
}: HoldToTalkProps) {
  const [recording, setRecording] = useState(false);
  // Guards against a stop firing before warm-up resolves, or two stops racing.
  const activeRef = useRef(false);
  // Ownership token for the turn this button started, or null if the engine was
  // busy (the other side is holding). Only a non-null token may stop the turn.
  const tokenRef = useRef<number | null>(null);

  async function begin(e: React.PointerEvent<HTMLButtonElement>) {
    // Refuse a NEW hold outright while disabled (e.g. mid-TTS-playback, the
    // mic gate — locked decision 2) — checked before anything else starts.
    if (disabled) return;
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
      // A null token means the other side owns the mic — startRecording never
      // arms the callback, so the button stays honestly idle (never shows
      // "recording" for a turn that didn't start).
      tokenRef.current = engine.startRecording(() => {
        if (activeRef.current) setRecording(true);
      });
    } catch (err) {
      activeRef.current = false;
      tokenRef.current = null;
      setRecording(false);
      if (err instanceof RecorderError) onError(err.kind);
      else onError("unavailable");
    }
  }

  async function end() {
    // Deliberately NOT gated on `disabled`: a hold already in progress must
    // still be able to end even if `disabled` flips true mid-hold (both
    // halves share one CaptureEngine, so the OTHER side's turn finishing
    // and triggering playback can happen while this side is still held
    // down). Refusing this pointer-up would strand the component believing
    // a hold is still active — worse than allowing a turn that the mic gate
    // will discard anyway (CaptureEngine.mute() drops every sample once
    // engaged, so ending here just produces a harmless gated "duration"
    // trip, not real audio sent anywhere).
    if (!activeRef.current) return;
    activeRef.current = false;
    setRecording(false);
    // Slice 4a `release` mark: pointerup, taken before the (synchronous) WAV
    // encode inside stopRecording, so release→encoded isolates encode cost.
    const releasedAt = performance.now();
    const token = tokenRef.current;
    tokenRef.current = null;
    // No token means this press never owned a turn (engine was busy, or released
    // during warm-up) — nothing to stop, nothing to report.
    if (token === null) return;
    try {
      const result = await engine.stopRecording(token);
      if (result === null) return;
      // A gate trip is silent by design (decision: the speaker didn't mean to
      // speak) — no audio, no error state, just a debug-list entry upstream.
      if ("gated" in result) onGated(result);
      else onCapture(result, releasedAt);
    } catch (err) {
      if (err instanceof RecorderError) onError(err.kind);
      else onError("unavailable");
    }
  }

  return (
    <button
      type="button"
      className={`hold-btn${recording ? " recording" : ""}${disabled ? " disabled" : ""}`}
      onPointerDown={begin}
      onPointerUp={end}
      onPointerCancel={end}
      aria-pressed={recording}
      aria-disabled={disabled}
    >
      {forSide(recording ? strings.recording : strings.holdToTalk, side)}
    </button>
  );
}
