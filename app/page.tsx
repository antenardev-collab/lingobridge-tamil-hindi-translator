"use client";

import { useEffect, useRef, useState } from "react";
import HoldToTalk from "@/components/HoldToTalk";
import { CaptureEngine, type Recording } from "@/lib/recorder";
import { strings, micErrorMessages, forSide, type MicErrorKind } from "@/lib/i18n";
import type { ServerDebug, Side, Turn, TurnTiming } from "@/lib/types";

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

/**
 * Defensively parse the additive `debug` key off a translate response. Unknown
 * shape → null (the turn just carries no server decomposition). Numbers only,
 * so a malformed payload can't poison the readout.
 */
function parseServerDebug(x: unknown): ServerDebug | null {
  if (!x || typeof x !== "object") return null;
  const d = x as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const total = num(d.serverTotalMs);
  if (total === null) return null; // the one field the transport derivation needs
  return {
    coldStart: d.coldStart === true,
    vercelId: typeof d.vercelId === "string" ? d.vercelId : null,
    weStream: d.weStream === true,
    entryToRequestMs: num(d.entryToRequestMs) ?? 0,
    requestToFirstByteMs: num(d.requestToFirstByteMs),
    requestToCompleteMs: num(d.requestToCompleteMs) ?? 0,
    completeToExitMs: num(d.completeToExitMs) ?? 0,
    serverTotalMs: total,
    residualMs: num(d.residualMs) ?? 0,
  };
}

/** Transport = client (encoded→complete) − server (entry→exit). Both same-clock. */
function transportMs(t: TurnTiming): number | null {
  if (!t.server) return null;
  return Math.round(t.complete - t.encoded - t.server.serverTotalMs);
}

/**
 * Analysis-ready export for one turn: client deltas (never raw performance.now
 * marks, which are meaningless out of context), payload/idle context, the server
 * decomposition, and the derived transport. Copied out as JSON for pasting.
 */
function exportTurn(t: Turn) {
  const tm = t.timing;
  return {
    id: t.id,
    side: t.side,
    status: t.status,
    original: t.original ?? null,
    translation: t.translation ?? null,
    errorLabel: t.errorLabel ?? null,
    durationSec: Number(t.durationSec.toFixed(3)),
    payloadBytes: tm?.payloadBytes ?? t.blob.size,
    impliedHz: t.durationSec ? Math.round((t.blob.size - 44) / 2 / t.durationSec) : null,
    firstTurn: tm?.firstTurn ?? null,
    sinceLastReleaseSec: tm?.sinceLastReleaseSec ?? null,
    client: tm
      ? {
          encodeMs: Math.round(tm.encoded - tm.release),
          ttfbMs: Math.round(tm.firstByte - tm.encoded),
          bodyReadMs: Math.round(tm.complete - tm.firstByte),
          roundTripMs: Math.round(tm.complete - tm.encoded),
        }
      : null,
    server: tm?.server ?? null,
    transportMs: tm ? transportMs(tm) : null,
  };
}

export default function Home() {
  // Session memory only — raw audio retained per turn, keyed by side
  // (locked decision 4). Not wired to anything yet.
  const [turns, setTurns] = useState<Turn[]>([]);
  const [micError, setMicError] = useState<MicErrorKind | null>(null);
  const [copied, setCopied] = useState(false);

  // Release mark of the previous turn (client clock), for firstTurn + the idle
  // gap. Null until the first release. A ref, not state — it must not re-render.
  const prevReleaseRef = useRef<number | null>(null);

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
  //
  // `releasedAt` is the pointerup mark (Slice 4a `release`). All four client marks
  // (release, encoded, firstByte, complete) are from this one client clock; the
  // server marks in `debug` are a different clock and are NEVER subtracted across.
  async function handleCapture(side: Side, rec: Recording, releasedAt: number) {
    const id = makeId();

    // Idle-gap context, computed at release against the previous turn's release.
    const prevRelease = prevReleaseRef.current;
    const firstTurn = prevRelease === null;
    const sinceLastReleaseSec = prevRelease === null ? null : (releasedAt - prevRelease) / 1000;
    prevReleaseRef.current = releasedAt;

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

    // Fill a timing object with what we know so far; the marks land as we go.
    const timing: TurnTiming = {
      release: releasedAt,
      encoded: 0,
      firstByte: 0,
      complete: 0,
      payloadBytes: rec.blob.size,
      firstTurn,
      sinceLastReleaseSec,
      server: null,
    };

    try {
      const fd = new FormData();
      fd.append("audio", rec.blob, "turn.wav");
      // sourceLang is the side that tapped (locked decision 1). pipeline omitted —
      // it inherits DEFAULT_PIPELINE (gemini-direct).
      fd.append("sourceLang", side);
      // encoded: WAV encode is already complete (it ran inside stopRecording);
      // mark immediately before fetch() so release→encoded isolates encode+pre-flight.
      timing.encoded = performance.now();
      const res = await fetch("/api/translate", { method: "POST", body: fd });
      // firstByte: response headers received (fetch promise resolved).
      timing.firstByte = performance.now();
      let data:
        | {
            original?: unknown;
            translation?: unknown;
            error?: unknown;
            detail?: unknown;
            debug?: unknown;
          }
        | null = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      // complete: response body fully read.
      timing.complete = performance.now();
      timing.server = parseServerDebug(data?.debug);
      const requestMs = Math.round(timing.complete - timing.encoded);

      if (!res.ok) {
        // Surface the route's own error + detail rather than a blanket "· model".
        // The route already distinguishes a genuine model failure ("model returned
        // malformed output") from a server/config one ("translation failed", e.g. a
        // missing GEMINI_API_KEY) — collapsing both to "model" actively misdirected
        // on the missing-key 502. detail carries the specifics (e.g. the key error).
        const routeError = data && typeof data.error === "string" ? data.error : "";
        const routeDetail = data && typeof data.detail === "string" ? data.detail : "";
        const errorLabel =
          `HTTP ${res.status} · ${routeError || "error"}` +
          (routeDetail ? ` · ${routeDetail}` : "");
        updateTurn(id, { status: "error", errorLabel, requestMs, timing });
        return;
      }
      const original = data && typeof data.original === "string" ? data.original : "";
      const translation = data && typeof data.translation === "string" ? data.translation : "";
      updateTurn(id, { status: "done", original, translation, requestMs, timing });
    } catch {
      timing.complete = performance.now();
      const requestMs = timing.encoded ? Math.round(timing.complete - timing.encoded) : undefined;
      updateTurn(id, { status: "error", errorLabel: "network", requestMs, timing });
    }
  }

  // Copy all accumulated turn timing as JSON for pasting out (Slice 4a). Debug
  // aid under decision 6. Newest first, so the most recent run is at the top.
  async function copyTimings() {
    const payload = {
      exportedAt: new Date().toISOString(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      turns: [...turns].reverse().map(exportTurn),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard needs a secure context; on failure, drop it to the console so
      // it's still recoverable from remote debugging.
      console.log("[timings]", JSON.stringify(payload, null, 2));
      setCopied(false);
    }
  }

  // Debug-only acceptance readout (locked decision 6): implied sample rate from
  // the PCM byte count and the independently measured wall-clock duration. A
  // correct 16 kHz encoder reads ~16000; a worklet silently at 48k would read ~48000.
  function impliedRate(t: Turn): number | null {
    if (!t.durationSec) return null;
    return Math.round((t.blob.size - 44) / 2 / t.durationSec);
  }

  // Slice 4a latency decomposition, rendered as compact debug lines under the
  // speaker's capture row (decision 6 — debug aid only). Client marks and server
  // marks are shown as separate lines because they are separate clocks; only
  // `transport` bridges them, via the sanctioned same-clock subtraction.
  function timingLines(tm: TurnTiming): string[] {
    const encodeMs = Math.round(tm.encoded - tm.release);
    const ttfbMs = Math.round(tm.firstByte - tm.encoded);
    const bodyMs = Math.round(tm.complete - tm.firstByte);
    const lines: string[] = [];
    const idle =
      tm.sinceLastReleaseSec === null
        ? "first turn"
        : `idle ${tm.sinceLastReleaseSec.toFixed(1)}s`;
    lines.push(`client: enc ${encodeMs} · ttfb ${ttfbMs} · body ${bodyMs} ms · ${idle}`);
    const s = tm.server;
    if (s) {
      const stream = s.weStream ? "stream" : "no-stream";
      lines.push(
        `server: total ${s.serverTotalMs} · setup ${s.entryToRequestMs} · ` +
          `gemini ${s.requestToCompleteMs} (${stream}) · post ${s.completeToExitMs} · ` +
          `resid ${s.residualMs} ms` +
          (s.coldStart ? " · COLD" : ""),
      );
      const tp = transportMs(tm);
      lines.push(
        `transport ~${tp} ms${s.vercelId ? ` · ${s.vercelId}` : ""}`,
      );
    } else {
      lines.push("server: no debug (pre-fetch or network failure)");
    }
    return lines;
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
        onCapture={(rec, releasedAt) => handleCapture(side, rec, releasedAt)}
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
                    {formatTime(t.timestamp)}
                    {t.timing &&
                      timingLines(t.timing).map((line, i) => (
                        <div key={i} className="turn-timing">
                          {line}
                        </div>
                      ))}
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
      {/*
        Slice 4a: copy accumulated per-turn timing as JSON for pasting out.
        Fixed top-right, small and dim, deliberately clear of the two speak
        buttons. Debug affordance only (decision 6). Hidden until a turn exists.
      */}
      {turns.length > 0 && (
        <button
          type="button"
          className="debug-copy"
          onClick={copyTimings}
          aria-label="Copy turn timings as JSON"
        >
          {copied ? "copied ✓" : `copy timings (${turns.length})`}
        </button>
      )}
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
