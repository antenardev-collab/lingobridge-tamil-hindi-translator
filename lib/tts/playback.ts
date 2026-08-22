import type { CaptureEngine } from "../recorder";

/**
 * Client-side TTS playback (Leg 2's client half). Fetches synthesised speech
 * from `/api/tts` and plays it, holding the mic gate (`CaptureEngine.mute`/
 * `unmute`, lib/recorder.ts) for the full duration of playback per locked
 * architecture decision 2 (CLAUDE.md). This module must NOT import from
 * lib/tts/elevenlabs.ts — that module is server-side and holds the API key;
 * this is client code and goes through the route like any other caller.
 *
 * Returns a discriminated union describing the outcome — never throws.
 *
 * TODO(4d): no timeout, no AbortSignal on the /api/tts request — a hung
 * request leaves this turn waiting indefinitely. Timeout-and-abandon policy
 * is Slice 4d's (see docs/PLAN.md), not this module's.
 */

/** Output language of the synthesised speech — the route's `targetLang`. */
export type TargetLang = "ta" | "hi";

/** Voice gender for synthesis — the route's `voiceGender`. */
export type VoiceGender = "male" | "female";

// Decision 2: unmute 250ms after `ended`, not immediately — the mic stays
// gated through a short reverb/room-tail window after the audio itself
// stops, so playback's own tail can't be picked up as the start of the next
// capture. Exported so lib/failure-audio.ts reuses this exact value rather
// than redeclaring it — the two gating sequences must not drift apart.
export const UNMUTE_DELAY_MS = 250;

/**
 * Playback started and completed: the full `ended` sequence ran, the gate
 * has ACTUALLY been released (this only resolves after the delayed
 * `unmute()` call has run — see `speak()`'s comment below), and the object
 * URL is revoked. Timing marks are elapsed ms from function ENTRY to each
 * named point — client clock only (`performance.now()`), never combined
 * with any server-reported duration (clock-skew rule).
 */
export interface PlaybackSuccess {
  ok: true;
  /** entry -> the /api/tts request being sent. */
  requestSentMs: number;
  /** entry -> the response body being fully read as a Blob (not chunked — see below). */
  responseReadMs: number;
  /** entry -> play() being called. */
  playCalledMs: number;
  /**
   * entry -> the gate actually being released (engine.unmute() called,
   * after the UNMUTE_DELAY_MS reverb-tail wait). Makes the unmute delay
   * observable rather than assumed, and is the true end of a turn — later
   * than `playCalledMs` by roughly playback duration + UNMUTE_DELAY_MS.
   */
  gateReleasedMs: number;
}

/**
 * No audio played, or playback didn't complete. `reason` distinguishes the
 * failure class; `status`/`error`/`detail` carry whatever /api/tts's own
 * error body supplied (for `http-error`) or a local description (for the
 * others) — mirrors lib/tts/elevenlabs.ts's TtsFailure shape, the existing
 * error-taxonomy style for this TTS leg.
 */
export interface PlaybackFailure {
  ok: false;
  /**
   * `fetch-failed` names the leg it describes: the CLIENT-to-server leg
   * (this browser failing to reach /api/tts, or failing to read its body).
   * `lib/tts/elevenlabs.ts`'s `TtsFailure.reason` also has a value spelled
   * `"network-error"`, but that one means the SERVER-to-provider leg
   * (Vercel failing to reach ElevenLabs) — a different failure, on a
   * different machine, on a different leg. Keep the names distinguishable:
   * a log line reading bare "network-error" would be ambiguous about which
   * leg actually failed.
   */
  reason: "fetch-failed" | "http-error" | "empty-audio" | "playback-error";
  /** HTTP status from /api/tts, where a response was received. */
  status: number | null;
  /** The route's own `error` field, where a JSON error body was returned. */
  error: string | null;
  /** The route's `detail` field, or a local description for non-HTTP failures. */
  detail: string | null;
}

/** Discriminated on `ok`, matching TtsResult (lib/tts/elevenlabs.ts) and Turn (lib/types.ts). */
export type PlaybackResult = PlaybackSuccess | PlaybackFailure;

/**
 * Synthesise and speak `text` in `targetLang`/`voiceGender`, gating `engine`
 * for the full duration. Resolves only once the gate has ACTUALLY been
 * released — i.e. after `ended`/error AND the UNMUTE_DELAY_MS delay have
 * both elapsed and `engine.unmute()` has actually run — not merely once
 * playback starts, and not the instant it ends either. The caller's
 * question is "is the mic live again"; resolving before the delayed
 * unmute() call has actually run would report the mic live 250ms too soon.
 */
export async function speak(
  text: string,
  targetLang: TargetLang,
  voiceGender: VoiceGender,
  engine: CaptureEngine,
): Promise<PlaybackResult> {
  const entry = performance.now();

  let res: Response;
  try {
    res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, targetLang, voiceGender }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: "fetch-failed",
      status: null,
      error: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const requestSentMs = performance.now() - entry;

  if (res.status !== 200) {
    // Nothing plays on a non-200 — never engage the gate for a request that
    // produced no audio.
    let errorField: string | null = null;
    let detailField: string | null = null;
    try {
      const body: unknown = await res.json();
      const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      errorField = typeof record.error === "string" ? record.error : null;
      detailField = typeof record.detail === "string" ? record.detail : null;
    } catch {
      // Non-JSON error body — leave both null rather than guess.
    }
    return { ok: false, reason: "http-error", status: res.status, error: errorField, detail: detailField };
  }

  // Complete-response fetch, not chunked playback. Chunked playback was
  // measured and rejected: server-side savings were only 15-245ms while
  // transport is the dominant, noisiest cost — see docs/PLAN.md -> Slice 4,
  // "Client playback format." Fetch the whole body, then play.
  let blob: Blob;
  try {
    blob = await res.blob();
  } catch (err) {
    return {
      ok: false,
      reason: "fetch-failed",
      status: res.status,
      error: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const responseReadMs = performance.now() - entry;

  if (blob.size === 0) {
    // A silent response must be reported, not played: silence is
    // indistinguishable from a working app that simply said nothing, so the
    // caller needs an explicit signal to tell the two apart. Never engage
    // the gate — nothing is going to play.
    return {
      ok: false,
      reason: "empty-audio",
      status: res.status,
      error: null,
      detail: "response body was 0 bytes",
    };
  }

  const url = URL.createObjectURL(blob);
  const audio = new Audio();
  audio.src = url;

  return new Promise<PlaybackResult>((resolve) => {
    // `claimed` is the single guard: it ensures exactly ONE terminal path
    // (ended, error, or play() rejecting) schedules the gate release,
    // however playback ends — a second scheduled unmute() would be
    // harmless in itself, but a stuck-engaged gate from a path that never
    // got to schedule its release would leave the app permanently deaf,
    // which is worse than one failed turn. The same guard means this
    // promise also resolves exactly once.
    let claimed = false;

    function cleanupUrl() {
      URL.revokeObjectURL(url);
    }

    // Schedules the ACTUAL gate release (decision 2's UNMUTE_DELAY_MS
    // reverb-tail wait) and resolves only once engine.unmute() has actually
    // run — never before. `build` receives the real gateReleasedMs mark,
    // taken at the moment unmute() is called, not at schedule time.
    function settleAfterRelease(build: (gateReleasedMs: number) => PlaybackResult) {
      if (claimed) return;
      claimed = true;
      setTimeout(() => {
        engine.unmute();
        const gateReleasedMs = performance.now() - entry;
        resolve(build(gateReleasedMs));
      }, UNMUTE_DELAY_MS);
    }

    // Playback finished on its own — the URL can be revoked immediately
    // (the element no longer needs it); the promise settles once the
    // delayed gate release has actually happened.
    audio.onended = () => {
      cleanupUrl();
      settleAfterRelease((gateReleasedMs) => ({
        ok: true,
        requestSentMs,
        responseReadMs,
        playCalledMs,
        gateReleasedMs,
      }));
    };

    // The element's error event — handled the same way as a play() rejection:
    // revoke, then settle (after the gate actually releases) with a failure
    // identifying it.
    audio.onerror = () => {
      cleanupUrl();
      settleAfterRelease(() => ({
        ok: false,
        reason: "playback-error",
        status: res.status,
        error: null,
        detail: "audio element reported an error event",
      }));
    };

    // Engage the gate immediately before play(), NOT after it resolves:
    // play()'s returned promise resolves AFTER playback has already begun,
    // so gating on resolution would leave a window where the speaker is
    // audible to the microphone before the gate engages.
    engine.mute();
    const playCalledMs = performance.now() - entry;

    audio.play().catch((err: unknown) => {
      // play() rejected — autoplay policy, decode failure, anything.
      // `ended` will never fire for a play() that never started, so this is
      // the only place that terminates this attempt.
      cleanupUrl();
      settleAfterRelease(() => ({
        ok: false,
        reason: "playback-error",
        status: res.status,
        error: null,
        detail: err instanceof Error ? err.message : String(err),
      }));
    });
  });
}
