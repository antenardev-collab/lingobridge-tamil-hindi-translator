import type { CaptureEngine } from "../recorder";

/**
 * Client-side TTS playback (Leg 2's client half). Fetches synthesised speech
 * from `/api/tts` and plays it, holding the mic gate (`CaptureEngine.mute`/
 * `unmute`, lib/recorder.ts) for the full duration of playback per locked
 * architecture decision 2 (CLAUDE.md). This module must NOT import from
 * lib/tts/elevenlabs.ts — that module is server-side and holds the API key;
 * this is client code and goes through the route like any other caller.
 *
 * Returns a discriminated union describing the outcome — never throws, and
 * (Slice 4d step 2) always settles: every path that can leave the promise
 * pending has a bound on it now.
 *
 * Timeout handling (Slice 4d step 2), two independent mechanisms for two
 * independent failure modes:
 *   1. The /api/tts fetch and the response body read share one
 *      FETCH_TIMEOUT_MS AbortController — a stalled request or a stalled
 *      download both surface as PlaybackFailure{reason:"fetch-timeout"}
 *      rather than hanging.
 *   2. Once playback has genuinely started, a separate PLAYBACK_STALL_MS
 *      watchdog (armed when play() resolves, reset on every `timeupdate`)
 *      catches what a fetch timeout cannot: playback starting and then
 *      silently stalling with neither `ended` nor `error` ever firing.
 *      Previously this left the mic gate engaged permanently, with no
 *      recovery but a page reload — see docs/PLAN.md.
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

// Ceiling on the /api/tts fetch + response body read, combined. Deliberately
// FLAT, not modelled on input length: unlike the Gemini leg (docs/PLAN.md —
// the linear 795ms + 64ms/sec fit from the Slice 4d longform probe), no
// measured relationship exists between input text length and TTS latency at
// long text lengths, so a formula here would be invented, not derived.
const FETCH_TIMEOUT_MS = 8000;

// No-progress threshold for the post-play() watchdog. `timeupdate` fires
// roughly four times a second while audio is genuinely advancing, so
// PLAYBACK_STALL_MS is chosen to comfortably exceed that firing interval
// many times over — this detects a stall of ANY kind (decode hang, OS/media
// session interruption, anything) without ever having to estimate how long
// the audio SHOULD take, which nothing in this module knows.
const PLAYBACK_STALL_MS = 3000;

/** `err.name === "AbortError"` without assuming AbortError is an `instanceof
 * Error` — mirrors the same check in app/api/translate/route.ts. */
function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

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
  /**
   * Slice 4d step 2 additions. `fetch-timeout` names the FETCH_TIMEOUT_MS
   * ceiling expiring — distinct from `fetch-failed` (a real error, not a
   * deadline) so the two are diagnosable apart. `playback-stall` names the
   * PLAYBACK_STALL_MS watchdog firing after `play()` had already resolved —
   * distinct from `playback-error` (the audio element itself reported an
   * error) because a stall is silence, not an error event.
   */
  reason:
    | "fetch-failed"
    | "http-error"
    | "empty-audio"
    | "playback-error"
    | "fetch-timeout"
    | "playback-stall";
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

  // Shared AbortController for the fetch AND the body read below — a
  // stalled download hangs just as effectively as a stalled request, so
  // both must be inside the same deadline. Cleared on every exit from this
  // guarded section (success or failure) so a completed attempt never
  // leaves a pending timer.
  const fetchController = new AbortController();
  const fetchTimer = setTimeout(() => fetchController.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, targetLang, voiceGender }),
      signal: fetchController.signal,
    });
  } catch (err) {
    clearTimeout(fetchTimer);
    if (isAbortError(err)) {
      return {
        ok: false,
        reason: "fetch-timeout",
        status: null,
        error: null,
        detail: `no response from /api/tts within ${FETCH_TIMEOUT_MS}ms`,
      };
    }
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
    clearTimeout(fetchTimer);
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
    clearTimeout(fetchTimer);
    if (isAbortError(err)) {
      return {
        ok: false,
        reason: "fetch-timeout",
        status: res.status,
        error: null,
        detail: `response body did not finish downloading within ${FETCH_TIMEOUT_MS}ms`,
      };
    }
    return {
      ok: false,
      reason: "fetch-failed",
      status: res.status,
      error: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  clearTimeout(fetchTimer);
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

    // Post-play() stall watchdog. `watchdogTimer` is null whenever it isn't
    // currently armed, so clearWatchdog is always safe to call even before
    // the watchdog has ever been armed (see the play().catch() path below).
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

    function clearWatchdog() {
      if (watchdogTimer !== null) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    }

    function armWatchdog() {
      watchdogTimer = setTimeout(() => {
        // No `timeupdate` for PLAYBACK_STALL_MS since playback genuinely
        // started (or since the last one) — pause first so a stalled
        // element cannot resume later against a mic that has since been
        // reopened, then release through the single settleAfterRelease
        // path, same as every other terminal path.
        audio.pause();
        settleAfterRelease(() => ({
          ok: false,
          reason: "playback-stall",
          status: res.status,
          error: null,
          detail: `no playback progress for ${PLAYBACK_STALL_MS}ms`,
        }));
      }, PLAYBACK_STALL_MS);
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

    // Resets the watchdog on every sign of genuine progress. Fires roughly
    // four times a second while audio is actually advancing — comfortably
    // inside PLAYBACK_STALL_MS, so a real stall of any kind (not just a
    // specific error condition) gets caught without this module ever having
    // to know or estimate how long the audio should take.
    audio.ontimeupdate = () => {
      clearWatchdog();
      armWatchdog();
    };

    // Playback finished on its own — the URL can be revoked immediately
    // (the element no longer needs it); the promise settles once the
    // delayed gate release has actually happened.
    audio.onended = () => {
      clearWatchdog();
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
      clearWatchdog();
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

    audio
      .play()
      .then(() => {
        // Armed on RESOLUTION, not on the play() call itself: if
        // `timeupdate` never fires at all after this, the watchdog must
        // still be the one thing standing between a silent stall and a
        // permanently engaged gate.
        armWatchdog();
      })
      .catch((err: unknown) => {
        // play() rejected — autoplay policy, decode failure, anything.
        // `ended` will never fire for a play() that never started, so this
        // is the only place that terminates this attempt. The watchdog was
        // never armed on this path (armWatchdog only runs in .then()
        // above), but clearWatchdog is always safe to call regardless.
        clearWatchdog();
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
