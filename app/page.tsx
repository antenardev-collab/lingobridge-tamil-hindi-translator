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

  function updateTurn(id: string, patch: Partial<Turn>) {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  // On release: register the turn (status "loading", raw WAV retained per locked
  // decision 4) and fire its own /api/translate request. Requests run in parallel
  // and never block capture — each resolves independently by id, no cancellation.
  async function handleCapture(side: Side, rec: Recording) {
    const id = makeId();
    setTurns((prev) => [
      ...prev,
      {
        id,
        side,
        blob: rec.blob,
        mimeType: rec.mimeType,
        durationSec: rec.durationSec,
        timestamp: Date.now(),
        status: "loading",
      },
    ]);

    const started = performance.now();
    try {
      const fd = new FormData();
      fd.append("audio", rec.blob, "turn.wav");
      // sourceLang is the side that tapped (locked decision 1). pipeline omitted —
      // it inherits DEFAULT_PIPELINE (gemini-direct).
      fd.append("sourceLang", side);
      const res = await fetch("/api/translate", { method: "POST", body: fd });
      const requestMs = Math.round(performance.now() - started);
      let data: { original?: unknown; translation?: unknown } | null = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        // Keep the two failure sources distinct: 400 means our capture sent bad
        // bytes (form / sourceLang / non-WAV), 502 means the model returned garbage.
        const errorLabel =
          res.status === 400
            ? "HTTP 400 · capture"
            : res.status === 502
              ? "HTTP 502 · model"
              : `HTTP ${res.status}`;
        updateTurn(id, { status: "error", errorLabel, requestMs });
        return;
      }
      const original = data && typeof data.original === "string" ? data.original : "";
      const translation = data && typeof data.translation === "string" ? data.translation : "";
      updateTurn(id, { status: "done", original, translation, requestMs });
    } catch {
      const requestMs = Math.round(performance.now() - started);
      updateTurn(id, { status: "error", errorLabel: "network", requestMs });
    }
  }

  // Debug-only acceptance readout (locked decision 6): implied sample rate from
  // the PCM byte count and the independently measured wall-clock duration. A
  // correct 16 kHz encoder reads ~16000; a worklet silently at 48k would read ~48000.
  function impliedRate(t: Turn): number | null {
    if (!t.durationSec) return null;
    return Math.round((t.blob.size - 44) / 2 / t.durationSec);
  }

  // TEMPORARY Slice 3 debug affordance — download a turn's retained raw WAV
  // (locked decision 4) from the phone to inspect the capture waveform for the
  // utterance-initial number-drop investigation. Throwaway, same status as /diag
  // was — remove once capture-loss vs model-behaviour is settled.
  function downloadTurn(t: Turn) {
    const url = URL.createObjectURL(t.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `turn-${t.side}-${new Date(t.timestamp)
      .toISOString()
      .replace(/[:.]/g, "-")}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Every turn shows on BOTH halves: the speaker's side shows `original`, the
  // listener's side shows `translation` — each already in that side's script.
  // Debug text only (locked decision 6); the capture debug row is speaker-side.
  const half = (side: Side) => (
    <section className={`half ${side}`}>
      <h1 className="half-heading">{strings.heading[side]}</h1>
      <HoldToTalk
        side={side}
        engine={engine}
        onCapture={(rec) => handleCapture(side, rec)}
        onError={setMicError}
        onStart={() => setMicError(null)}
      />
      <div className="turns" aria-live="polite">
        {turns.length === 0 ? (
          <div className="turn-empty">{forSide(strings.noTurnsYet, side)}</div>
        ) : (
          turns.map((t) => {
            const isSpeaker = t.side === side;
            const rate = impliedRate(t);
            const text =
              t.status === "loading"
                ? "…"
                : t.status === "error"
                  ? `⚠ ${t.errorLabel ?? "error"}`
                  : (isSpeaker ? t.original : t.translation) || "—";
            return (
              <div
                key={t.id}
                className={`turn-row${t.status === "error" ? " turn-error" : ""}`}
              >
                <div className="turn-text">{text}</div>
                {isSpeaker && (
                  <div className="turn-debug">
                    {formatBytes(t.blob.size)} · {t.durationSec.toFixed(2)}s ·{" "}
                    {rate === null ? "—" : `~${rate} Hz`}
                    {t.requestMs != null ? ` · ${t.requestMs} ms` : ""} ·{" "}
                    {formatTime(t.timestamp)}{" "}
                    {/* TEMPORARY debug: download raw WAV (see downloadTurn). */}
                    <button type="button" className="turn-dl" onClick={() => downloadTurn(t)}>
                      ⬇ wav
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );

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
