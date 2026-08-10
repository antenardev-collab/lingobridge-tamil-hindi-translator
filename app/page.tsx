"use client";

import { useEffect, useRef, useState } from "react";
import HoldToTalk from "@/components/HoldToTalk";
import { CaptureEngine, type Recording } from "@/lib/recorder";
import { strings, micErrorMessages, forSide, type MicErrorKind } from "@/lib/i18n";
import type { Side, Turn } from "@/lib/types";

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function Home() {
  // Session memory only — raw audio retained per turn, keyed by side
  // (locked decision 4). Not wired to anything yet.
  const [turns, setTurns] = useState<Turn[]>([]);
  const [micError, setMicError] = useState<MicErrorKind | null>(null);

  // One warm capture engine shared by both halves (one mic/context for the
  // device). Constructed here but it touches no audio until ensureWarm() runs on
  // the first pointerdown — so nothing is acquired at page load. Disposed on unmount.
  const engineRef = useRef<CaptureEngine | null>(null);
  const engine = (engineRef.current ??= new CaptureEngine());
  // Dispose the warm graph on unmount (stops the mic, closes the context). Uses
  // the stable ref, not `engine`, so the effect runs once.
  useEffect(() => () => void engineRef.current?.dispose(), []);

  function addTurn(side: Side, rec: Recording) {
    setTurns((prev) => [
      ...prev,
      {
        id: makeId(),
        side,
        blob: rec.blob,
        mimeType: rec.mimeType,
        durationSec: rec.durationSec,
        timestamp: Date.now(),
      },
    ]);
  }

  // Debug-only acceptance readout (locked decision 6): implied sample rate from
  // the PCM byte count and the independently measured wall-clock duration. A
  // correct 16 kHz encoder reads ~16000; a worklet silently at 48k would read ~48000.
  function impliedRate(t: Turn): number | null {
    if (!t.durationSec) return null;
    return Math.round((t.blob.size - 44) / 2 / t.durationSec);
  }

  const half = (side: Side) => {
    const sideTurns = turns.filter((t) => t.side === side);
    return (
      <section className={`half ${side}`}>
        <h1 className="half-heading">{strings.heading[side]}</h1>
        <HoldToTalk
          side={side}
          engine={engine}
          onCapture={(rec) => addTurn(side, rec)}
          onError={setMicError}
          onStart={() => setMicError(null)}
        />
        <div className="turns" aria-live="polite">
          {sideTurns.length === 0 ? (
            <div className="turn-empty">{forSide(strings.noTurnsYet, side)}</div>
          ) : (
            sideTurns.map((t) => {
              const rate = impliedRate(t);
              return (
                <div key={t.id} className="turn-row">
                  {formatBytes(t.blob.size)} · {t.durationSec.toFixed(2)}s ·{" "}
                  {rate === null ? "—" : `~${rate} Hz`} · {formatTime(t.timestamp)}
                </div>
              );
            })
          )}
        </div>
      </section>
    );
  };

  return (
    <main className="screen">
      {half("ta")}
      {half("hi")}
      {micError && (
        <div className="mic-error" role="alert">
          <span>{micErrorMessages[micError].ta}</span>
          <span>{micErrorMessages[micError].hi}</span>
          <span>{micErrorMessages[micError].en}</span>
        </div>
      )}
    </main>
  );
}
