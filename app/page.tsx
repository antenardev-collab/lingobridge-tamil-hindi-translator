"use client";

import { useEffect, useRef, useState } from "react";
import HoldToTalk from "@/components/HoldToTalk";
import { CaptureEngine, type GatedTurn, type Recording } from "@/lib/recorder";
import { strings, micErrorMessages, forSide, type MicErrorKind } from "@/lib/i18n";
import type { CapturedTurn, ServerDebug, Side, Turn, TurnTiming } from "@/lib/types";
import {
  speak,
  type PlaybackFailure,
  type PlaybackResult,
  type TargetLang,
  type VoiceGender,
} from "@/lib/tts/playback";
import { computeClientBackstopMs } from "@/lib/deadline";
import { playFailureAudio } from "@/lib/failure-audio";

// TODO(5): hardcoded until the Slice 5 setup UI supplies a gender per
// speaker. Gender follows the SPEAKER, not the translation direction (see
// lib/tts/elevenlabs.ts) — never inferred from anything; this is a
// placeholder, not an inference, and must be removed once Slice 5 lands.
const VOICE_GENDER: VoiceGender = "female";

/** Mirrors the repo's `HTTP status · error · detail` error style (see handleCapture's errorLabel) for a TTS-leg failure. */
function ttsFailureLabel(f: PlaybackFailure): string {
  const parts: string[] = [f.reason];
  if (f.status !== null) parts.push(`HTTP ${f.status}`);
  if (f.error) parts.push(f.error);
  if (f.detail) parts.push(f.detail);
  return parts.join(" · ");
}

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
    execRegion: typeof d.execRegion === "string" ? d.execRegion : null,
    edgeTrace: typeof d.edgeTrace === "string" ? d.edgeTrace : null,
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
 *
 * `ttsResult` is the settled speak() outcome for this turn, if any (component
 * state in Home, keyed by turn id — a gated turn never has one). Its four
 * timing marks (requestSentMs/responseReadMs/playCalledMs/gateReleasedMs) are
 * ALL client-clock (performance.now()) — same rule as the translate-leg
 * marks above: never combined with any server-reported duration.
 */
function exportTurn(t: Turn, ttsResult?: PlaybackResult) {
  if (t.status === "gated") {
    // A gate trip never became a turn — export just the evidence whichever
    // check (duration or energy) acted on, not the request/timing shape of a
    // real turn.
    return {
      id: t.id,
      side: t.side,
      status: t.status,
      gatedReason: t.gatedReason,
      gatedSamples: t.gatedSamples,
      gatedImpliedMs: t.gatedImpliedMs,
      gatedRmsDbfs: t.gatedRmsDbfs !== undefined ? Number(t.gatedRmsDbfs.toFixed(1)) : null,
    };
  }
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
    // TEMPORARY — 4b.2 energy-gate measurement, not used for gating.
    amplitude: {
      rmsLinear: Number(t.amplitude.rmsLinear.toFixed(6)),
      rmsDbfs: Number(t.amplitude.rmsDbfs.toFixed(1)),
      peakLinear: Number(t.amplitude.peakLinear.toFixed(6)),
      peakDbfs: Number(t.amplitude.peakDbfs.toFixed(1)),
    },
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
    tts: !ttsResult
      ? null
      : ttsResult.ok
        ? {
            ok: true,
            requestSentMs: Math.round(ttsResult.requestSentMs),
            responseReadMs: Math.round(ttsResult.responseReadMs),
            playCalledMs: Math.round(ttsResult.playCalledMs),
            gateReleasedMs: Math.round(ttsResult.gateReleasedMs),
          }
        : {
            ok: false,
            reason: ttsResult.reason,
            status: ttsResult.status,
            error: ttsResult.error,
            detail: ttsResult.detail,
          },
  };
}

export default function Home() {
  // Session memory only — raw audio retained per turn, keyed by side
  // (locked decision 4). Not wired to anything yet.
  const [turns, setTurns] = useState<Turn[]>([]);
  const [micError, setMicError] = useState<MicErrorKind | null>(null);
  const [copied, setCopied] = useState(false);

  // Id of the turn currently being spoken, or null when nothing is playing.
  // Doubles as the busy flag the split-screen buttons gate on below — the
  // mic is a single shared CaptureEngine, so at most one turn ever speaks
  // at a time.
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  // Settled speak() outcome per turn id, for the debug area and the
  // copy-timings export (exportTurn). Local UI/debug state only — not part
  // of the shared Turn/CapturedTurn shape (lib/types.ts).
  const [ttsResults, setTtsResults] = useState<Record<string, PlaybackResult>>({});

  // TODO(remove-before-beta): Slice 4d temporary test affordance. Set once
  // on mount from ?forcetimeout=1 in the URL; when true, every turn sends
  // forceTimeout: "1" to /api/translate so the 504 path and the failure
  // sounds can be exercised on demand on a real phone instead of waiting
  // for a genuine failure (none has occurred in 105 probe requests). Delete
  // this state, the effect below, its FormData use in handleCapture, and
  // the on-screen indicator before shop testing.
  const [forceTimeoutMode, setForceTimeoutMode] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setForceTimeoutMode(params.get("forcetimeout") === "1");
  }, []);

  // Release mark of the previous turn (client clock), for firstTurn + the idle
  // gap. Null until the first release. A ref, not state — it must not re-render.
  const prevReleaseRef = useRef<number | null>(null);

  // Consecutive-failure count per side (Slice 4d), for tier 2 (the
  // per-speaker spoken message) in lib/failure-audio.ts. A ref, not state —
  // it must not re-render, and unlike prevReleaseRef this is scoped PER
  // SIDE: each speaker's run of failures is independent of the other's.
  const failureCountRef = useRef<Record<Side, number>>({ ta: 0, hi: 0 });

  // Consecutive-failure count, GLOBAL across both sides, for tier 3 (the
  // service-down message). A ref, not state. Tier 2 (per-side, above) means
  // THIS speaker's turn failed, which is personal; tier 3 means the service
  // itself is down, which isn't — two Tamil failures plus one Hindi failure
  // is three failures and the thing is broken for both people, so this
  // counts across sides rather than resetting per side.
  const globalFailureCountRef = useRef(0);

  // One warm capture engine shared by both halves (one mic/context for the
  // device). Constructed here but it touches no audio until ensureWarm() runs on
  // the first pointerdown — so nothing is acquired at page load. Disposed on unmount.
  const engineRef = useRef<CaptureEngine | null>(null);
  const engine = (engineRef.current ??= new CaptureEngine());
  // Dispose the warm graph on unmount (stops the mic, closes the context). Uses
  // the stable ref, not `engine`, so the effect runs once.
  useEffect(() => () => void engineRef.current?.dispose(), []);

  // Single implementation both legs (translate and TTS) call on failure —
  // both legs feed both counters, since to the person a translate-leg
  // failure and a TTS-leg failure are indistinguishable: the turn just
  // didn't come through. Global takes precedence over per-side: tier 3 once
  // the GLOBAL count has reached 3 regardless of this side's own count;
  // otherwise tier 2 once THIS side's count has reached 2; otherwise tier 1.
  // Fired without awaiting so the failure path never blocks.
  function registerFailure(side: Side) {
    failureCountRef.current[side] += 1;
    globalFailureCountRef.current += 1;
    const tier = globalFailureCountRef.current >= 3 ? 3 : failureCountRef.current[side] >= 2 ? 2 : 1;
    void playFailureAudio(side, tier, engine);
  }

  // Single implementation both legs call on success — resets both counters,
  // so tier 3 (the service-down read) requires three failures with no
  // success anywhere in between, on either side. Only the translate-leg
  // success path actually calls this (see below): the translate leg already
  // resets when it succeeds, and a subsequent TTS success adds nothing.
  function registerSuccess(side: Side) {
    failureCountRef.current[side] = 0;
    globalFailureCountRef.current = 0;
  }

  // Patches only ever apply to a CapturedTurn (a "loading" turn resolving to
  // "done"/"error") — a gate trip is terminal from the moment it's pushed and
  // never goes through updateTurn. Typed on CapturedTurn, not Turn, so patch
  // can't accidentally carry gated-only fields; the `t.status !== "gated"`
  // guard is what lets TS narrow `t` to CapturedTurn for the spread (ids never
  // actually collide across the two variants, so this doesn't change which
  // turn gets updated — it's a type-narrowing guard, not new behaviour).
  function updateTurn(id: string, patch: Partial<CapturedTurn>) {
    setTurns((prev) =>
      prev.map((t) => (t.id === id && t.status !== "gated" ? { ...t, ...patch } : t)),
    );
  }

  // On a gate trip (duration OR energy, lib/recorder.ts's two 4b.2 checks):
  // the release never became a turn. No audio, no error state, no toast —
  // just a debug-list entry, distinguishable by status "gated" and tagged
  // with which check fired, so real-use trip frequency (and, for energy
  // trips, how close to threshold) can be counted. prevReleaseRef is
  // deliberately left untouched: a trip isn't a real turn and shouldn't
  // reset the idle-gap baseline used for latency debug.
  function handleGated(side: Side, gated: GatedTurn) {
    setTurns((prev) => [
      ...prev,
      {
        id: makeId(),
        side,
        timestamp: Date.now(),
        status: "gated",
        gatedSamples: gated.samples,
        gatedImpliedMs: gated.impliedMs,
        gatedReason: gated.reason,
        gatedRmsDbfs: gated.rmsDbfs,
      },
    ]);
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
        amplitude: rec.amplitude,
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

    // Client-side backstop (Slice 4d): bounds the BROWSER's wait, distinct
    // from the server's own AbortController around its Gemini call — a dead
    // network or a response that never arrives would otherwise hang this
    // turn forever. Shares its arithmetic with the server (lib/deadline.ts)
    // so the two can't drift, and computeClientBackstopMs already guarantees
    // the client never gives up before the server does.
    const controller = new AbortController();
    const backstopMs = computeClientBackstopMs(rec.durationSec);
    const timer = setTimeout(() => controller.abort(), backstopMs);

    try {
      const fd = new FormData();
      fd.append("audio", rec.blob, "turn.wav");
      // sourceLang is the side that tapped (locked decision 1). pipeline omitted —
      // it inherits DEFAULT_PIPELINE (gemini-direct).
      fd.append("sourceLang", side);
      // durationSec is a HINT only, not authoritative: the server parses the
      // WAV itself (lib/wav-duration.ts) and uses this value solely as a
      // fallback when its own parse fails — never trusted over the parse.
      fd.append("durationSec", String(rec.durationSec));
      // TODO(remove-before-beta): Slice 4d temporary test affordance — see
      // the forceTimeoutMode state declaration above.
      if (forceTimeoutMode) {
        fd.append("forceTimeout", "1");
      }
      // encoded: WAV encode is already complete (it ran inside stopRecording);
      // mark immediately before fetch() so release→encoded isolates encode+pre-flight.
      timing.encoded = performance.now();
      const res = await fetch("/api/translate", {
        method: "POST",
        body: fd,
        signal: controller.signal,
      });
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
        // Failure audio (Slice 4d — three-tier escalation, see
        // registerFailure above). Not gated on error kind — a timeout, a
        // 502, and a network error all produce the same sound; the person
        // repeats regardless, and the distinct 504 exists for our
        // diagnosis only.
        registerFailure(side);
        return;
      }
      const original = data && typeof data.original === "string" ? data.original : "";
      const translation = data && typeof data.translation === "string" ? data.translation : "";
      updateTurn(id, { status: "done", original, translation, requestMs, timing });
      // A successful translate-leg turn ends both failure runs (see
      // registerSuccess above) — TTS success below does not call this again.
      registerSuccess(side);
      // Speak the translation now that it's rendered (locked decision 2).
      // translation can legitimately be empty (a malformed-but-200 response);
      // there's nothing to synthesise in that case, so don't bother speak().
      if (translation.trim()) void speakTranslation(id, translation, side);
    } catch (err) {
      timing.complete = performance.now();
      const requestMs = timing.encoded ? Math.round(timing.complete - timing.encoded) : undefined;
      // Distinguish our own backstop firing from any other network failure —
      // everything else keeps the existing "network" label unchanged.
      const aborted =
        typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
      updateTurn(id, {
        status: "error",
        errorLabel: aborted ? "client timeout" : "network",
        requestMs,
        timing,
      });
      // Same failure audio as the !res.ok branch above — see registerFailure.
      registerFailure(side);
    } finally {
      // Runs on every exit path — the early return in the !res.ok branch,
      // the normal fall-through on success, and the catch above — so a
      // completed request never leaves a pending timer that could fire
      // later and abort a controller nothing is still listening to.
      clearTimeout(timer);
    }
  }

  // Fires after a turn's translation is on screen. Not awaited by the caller
  // (handleCapture already treats each turn's request as independent/
  // parallel; TTS is the same) — updates ttsResults/speakingId as speak()
  // settles instead. On failure: no alert(), no retry — the turn is over.
  // The translated text stays on screen exactly as already rendered above,
  // which is a degraded-but-usable outcome; the project's stated fallback
  // preference is to degrade toward ugly rather than toward nothing (see
  // lib/tts/elevenlabs.ts's word-slur finding in docs/PLAN.md for the same
  // principle applied elsewhere on this leg).
  async function speakTranslation(id: string, translation: string, sourceLang: Side) {
    // Target is the OPPOSITE of sourceLang: a Tamil source produces Hindi
    // speech and vice versa. Derived explicitly here, never by reusing
    // `sourceLang`/`Side` as-is — this exact speaker-side/output-language
    // inversion is what TargetLang (lib/tts/playback.ts) and TtsTargetLang
    // (lib/tts/elevenlabs.ts) were deliberately kept separate FROM `Side`
    // to prevent a caller from getting backwards by construction.
    const targetLang: TargetLang = sourceLang === "ta" ? "hi" : "ta";

    setSpeakingId(id);
    const result = await speak(translation, targetLang, VOICE_GENDER, engine);
    setSpeakingId(null);
    setTtsResults((prev) => ({ ...prev, [id]: result }));
    // Feeds the same escalation counters as a translate-leg failure (Slice
    // 4d — three-tier escalation): to the person, a TTS failure and a
    // translate failure are indistinguishable — the turn didn't come
    // through either way. `sourceLang` is the SPEAKER's side, the same
    // `side` handleCapture's failures register against — this runs only
    // after a translate success, which already reset both counters, so a
    // TTS failure here correctly reads as the first failure of a fresh run,
    // not a continuation of a run that already ended in success.
    if (!result.ok) registerFailure(sourceLang);
  }

  // Copy all accumulated turn timing as JSON for pasting out (Slice 4a). Debug
  // aid under decision 6. Newest first, so the most recent run is at the top.
  async function copyTimings() {
    const payload = {
      exportedAt: new Date().toISOString(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      turns: [...turns].reverse().map((t) => exportTurn(t, ttsResults[t.id])),
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
    if (t.status === "gated" || !t.durationSec) return null;
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
        `transport ~${tp} ms${s.execRegion ? ` · ${s.execRegion}` : ""}`,
      );
    } else {
      lines.push("server: no debug (pre-fetch or network failure)");
    }
    return lines;
  }

  // The mic is ONE shared CaptureEngine, hard-gated (locked decision 2) for
  // the full duration of TTS playback — see lib/tts/playback.ts's speak().
  // A press during that window would silently produce a gated (duration-trip)
  // turn rather than a real capture (the muted engine discards every sample),
  // which would look broken to the user. Both halves share the same mic AND
  // the same `playing` flag: one speaker's completed turn can trigger
  // playback (speakTranslation, above) at any moment, including while the
  // OTHER speaker is mid-hold on their own button — so this gate can flip
  // true out from under an in-progress gesture. That's exactly why it's
  // passed as a real `disabled` prop to HoldToTalk (checked at pointerdown
  // to block a NEW hold, and deliberately NOT re-checked on pointerup — see
  // HoldToTalk's end()) rather than done with a pointer-events wrapper,
  // which would leave a hold already in progress stuck believing it's
  // still active.
  const playing = speakingId !== null;

  // Every turn shows on BOTH halves: the speaker's side shows `original`, the
  // listener's side shows `translation` — each already in that side's script.
  // Debug text only (locked decision 6); the capture debug row is speaker-side.
  const half = (side: Side) => (
    <section className={`half ${side}`}>
      <h1 className="half-heading">{strings.heading[side]}</h1>
      {/* Opacity only — the actual gate is HoldToTalk's own `disabled` prop
          below, not pointer-events on this wrapper (see the comment above
          `playing`). */}
      <div style={playing ? { opacity: 0.5 } : undefined}>
        <HoldToTalk
          side={side}
          engine={engine}
          onCapture={(rec, releasedAt) => handleCapture(side, rec, releasedAt)}
          onGated={(gated) => handleGated(side, gated)}
          onError={setMicError}
          onStart={() => setMicError(null)}
          disabled={playing}
        />
      </div>
      <div className="turns" aria-live="polite">
        {turns.length === 0 ? (
          <div className="turn-empty">{forSide(strings.noTurnsYet, side)}</div>
        ) : (
          turns.map((t) => {
            const isSpeaker = t.side === side;
            const rate = impliedRate(t);
            // Only a completed turn ever has one; ttsResults isn't touched
            // for "loading"/"error"/"gated" ids.
            const ttsResult = t.status === "done" ? ttsResults[t.id] : undefined;
            const text =
              t.status === "loading"
                ? "…"
                : t.status === "gated"
                  ? "⊘ skipped (too short)"
                  : t.status === "error"
                    ? `⚠ ${t.errorLabel ?? "error"}`
                    : (isSpeaker ? t.original : t.translation) || "—";
            return (
              <div
                key={t.id}
                className={`turn-row${t.status === "error" ? " turn-error" : ""}${t.status === "gated" ? " turn-gated" : ""}`}
              >
                <div className="turn-text">{text}</div>
                {isSpeaker && (
                  <div className="turn-debug">
                    {t.status === "gated" ? (
                      <>
                        gated ({t.gatedReason}) · {t.gatedSamples} samples · ~
                        {t.gatedImpliedMs} ms
                        {t.gatedReason === "energy" && t.gatedRmsDbfs !== undefined
                          ? ` · rms ${t.gatedRmsDbfs.toFixed(1)} dBFS`
                          : ""}{" "}
                        · {formatTime(t.timestamp)}
                      </>
                    ) : (
                      <>
                        {formatBytes(t.blob.size)} · {t.durationSec.toFixed(2)}s ·{" "}
                        {rate === null ? "—" : `~${rate} Hz`}
                        {t.requestMs != null ? ` · ${t.requestMs} ms` : ""} ·{" "}
                        {formatTime(t.timestamp)} · rms{" "}
                        {t.amplitude.rmsDbfs.toFixed(1)} dBFS · peak{" "}
                        {t.amplitude.peakDbfs.toFixed(1)} dBFS
                        {t.timing &&
                          timingLines(t.timing).map((line, i) => (
                            <div key={i} className="turn-timing">
                              {line}
                            </div>
                          ))}
                        {/* TTS-leg failure only — success carries no on-screen
                            line of its own (decision 6: minimal debug text);
                            its four marks still reach the copy-timings export
                            via exportTurn's `tts` field above. */}
                        {ttsResult && !ttsResult.ok && (
                          <div className="turn-timing">⚠ tts: {ttsFailureLabel(ttsResult)}</div>
                        )}
                      </>
                    )}
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
      {/* TODO(remove-before-beta): Slice 4d temporary test affordance — see
          the forceTimeoutMode state declaration above. Plain text, no
          styling effort, deliberately impossible to miss while active. */}
      {forceTimeoutMode && <div>FORCE TIMEOUT MODE ACTIVE — every turn will time out</div>}
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
