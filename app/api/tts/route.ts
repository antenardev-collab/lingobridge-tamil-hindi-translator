import { NextResponse } from "next/server";
import { synthesiseSpeech, type TtsFailure, type TtsVoiceGender } from "@/lib/tts/elevenlabs";

/**
 * Slice 4c cold-start detector — same pattern as /api/translate: module
 * scope, so it survives across invocations of one warm (Fluid) instance.
 */
let INSTANCE_WARMED = false;

/**
 * Maps every TtsFailure["reason"] to a status. Keyed off the union itself
 * (not duplicated as a literal list) so a new reason added to
 * lib/tts/elevenlabs.ts fails to compile here until it's mapped.
 */
const FAILURE_STATUS: Record<TtsFailure["reason"], number> = {
  "empty-text": 400,
  "missing-api-key": 500,
  "http-error": 502,
  "network-error": 502,
  // Same status as network-error: this route doesn't pass a signal into
  // synthesiseSpeech() yet (Slice 4d step 2 added the parameter, not a
  // caller), so this is unreachable today — mapped only to keep the build
  // green against the widened TtsFailure.reason union.
  aborted: 502,
};

/**
 * Server-clock latency decomposition for this route. Deliberately NOT the
 * same shape as /api/translate's ServerDebug (lib/types.ts): that type has a
 * required `requestToCompleteMs` — a "provider body fully read" mark that
 * doesn't exist here. This route relays `result.audio` to the client
 * unconsumed (never awaits/buffers the stream), so there is no
 * server-observable "complete" moment to time; measuring one would mean
 * buffering, which the streaming contract forbids. The only
 * completion-adjacent mark available on THIS (failure) path is time-to
 * -headers (when synthesiseSpeech() resolves), reported as
 * `providerHeadersMs` — this is headers arriving, NOT first audio byte;
 * the response body hasn't been touched yet at this point. (The success
 * path's actual first-audio-byte mark, `providerFirstAudioByteMs`, is
 * measured separately below, inside the audio stream wrapper, and reaches
 * us only via console.log — see that comment for why.) All marks below are
 * the SAME Node `performance.now()` clock — no client mark ever appears in
 * this file, so the project's clock-skew rule (never subtract a client mark
 * from a server mark) is satisfied trivially.
 */
interface TtsServerDebug {
  coldStart: boolean;
  execRegion: string | null;
  edgeTrace: string | null;
  /** Always true — unlike /api/translate, this route always relays a stream. */
  weStream: true;
  entryToRequestMs: number;
  /**
   * request -> synthesiseSpeech() resolving, i.e. the provider's response
   * HEADERS arriving — NOT the first audio byte. synthesiseSpeech() returns
   * as soon as it has a response with `res.status`/`res.body`; nothing in
   * the body has been read yet, so this cannot be (and must not be
   * mistaken for) a first-audio-byte measurement.
   */
  providerHeadersMs: number;
  /** headers arrived -> response constructed / handed back. */
  completeToExitMs: number;
  serverTotalMs: number;
  residualMs: number;
}

function buildDebug(
  entry: number,
  requestSent: number,
  responseReceived: number,
  exit: number,
  coldStart: boolean,
  execRegion: string | null,
  edgeTrace: string | null,
): TtsServerDebug {
  const round = (ms: number) => Math.round(ms);
  const entryToRequestMs = round(requestSent - entry);
  const providerHeadersMs = round(responseReceived - requestSent);
  const completeToExitMs = round(exit - responseReceived);
  const serverTotalMs = round(exit - entry);
  return {
    coldStart,
    execRegion,
    edgeTrace,
    weStream: true,
    entryToRequestMs,
    providerHeadersMs,
    completeToExitMs,
    serverTotalMs,
    residualMs: serverTotalMs - (entryToRequestMs + providerHeadersMs + completeToExitMs),
  };
}

/**
 * Wraps the provider's audio stream to measure the REAL first-audio-byte
 * time and total bytes forwarded, without buffering, copying, or delaying
 * any chunk — each chunk read from `source` is enqueued immediately and
 * unchanged. Reads via a manual pull loop (rather than a bare
 * TransformStream) specifically so an error on the source stream is caught
 * here directly: a plain `source.pipeThrough(transform)` would NOT reliably
 * invoke a transformer's `flush()` on an upstream error, which would silently
 * swallow exactly the "stream failed mid-flight" case this exists to catch.
 *
 * Logging is the ONLY way these marks can reach us: the response body is
 * binary audio (no JSON envelope to attach a debug field to — see the
 * success-path comment below), and by the time the first chunk exists the
 * HTTP status + headers have already been sent to the client, so there is no
 * way to hand this back to the caller after the fact either. console.log
 * carries counts and timings ONLY — never chunk content, never text, never
 * the API key.
 */
function instrumentAudioStream(
  source: ReadableStream<Uint8Array>,
  ctx: {
    entry: number;
    coldStart: boolean;
    providerHeadersMs: number;
    targetLang: string;
    voiceGender: string;
    textLength: number;
    execRegion: string | null;
  },
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let providerFirstAudioByteMs: number | null = null;
  let totalBytes = 0;
  let sawChunk = false;
  let logged = false;

  // Fires exactly once per request, however the stream ends (clean finish,
  // empty finish, error, or client cancel) — guarded by `logged` so no path
  // can double-log.
  function logOnce(outcome: "ok" | "empty" | "error" | "cancelled") {
    if (logged) return;
    logged = true;
    console.log(
      JSON.stringify({
        route: "/api/tts",
        outcome,
        // coldStart was previously missing from this line entirely — a
        // recorded gap (docs/PLAN.md -> Slice 4, "4c logging gap"). Read the
        // same way /api/translate reads it: read-then-set INSTANCE_WARMED
        // once per function instance, at request entry.
        coldStart: ctx.coldStart,
        targetLang: ctx.targetLang,
        voiceGender: ctx.voiceGender,
        textLength: ctx.textLength,
        providerHeadersMs: ctx.providerHeadersMs,
        providerFirstAudioByteMs,
        totalElapsedMs: Math.round(performance.now() - ctx.entry),
        totalBytes,
        execRegion: ctx.execRegion,
      }),
    );
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch {
        // Never log the error's own message/content — counts and timings
        // only. `sawChunk` alone is what makes a zero-audio failure
        // distinguishable from a normal completion.
        logOnce(sawChunk ? "error" : "empty");
        controller.error(new Error("upstream audio stream failed"));
        return;
      }
      const { done, value } = step;
      if (done) {
        logOnce(sawChunk ? "ok" : "empty");
        controller.close();
        return;
      }
      if (value.length > 0) {
        if (providerFirstAudioByteMs === null) {
          providerFirstAudioByteMs = Math.round(performance.now() - ctx.entry);
        }
        sawChunk = true;
        totalBytes += value.length;
      }
      // Forward the exact chunk just read, immediately — no copy, no
      // accumulation, no delay.
      controller.enqueue(value);
    },
    cancel(reason) {
      // Client disconnected/aborted before the stream finished on its own.
      logOnce(sawChunk ? "cancelled" : "empty");
      return reader.cancel(reason);
    },
  });
}

/**
 * POST /api/tts — synthesise speech via the locked TTS provider
 * (lib/tts/elevenlabs.ts). This route must not reference the provider
 * directly (no model IDs, no voice IDs, no provider URLs) — all of that is
 * lib/tts/elevenlabs.ts's job; this route only knows TtsResult.
 *
 * Accepts application/json:
 *   text        (string)              required — what to speak
 *   targetLang  ('ta'|'hi')            required — the OUTPUT language (not
 *                                      the speaker's side — see
 *                                      lib/tts/elevenlabs.ts's TtsTargetLang)
 *   voiceGender ('male'|'female')      optional FOR NOW — see the
 *                                      TODO(5) below; will become required
 *                                      once the Slice 5 setup UI exists.
 *                                      An explicitly invalid value still 400s.
 *
 * On success, returns the audio stream directly as the response body — no
 * validated JSON envelope, unlike /api/translate. Node runtime: matches
 * /api/translate's convention (this route doesn't itself need Buffer, but
 * the whole API surface stays on one runtime for consistency).
 */
export const runtime = "nodejs";

export async function POST(req: Request) {
  // Slice 4c marks (server clock) — see buildDebug's comment above for why
  // this shape differs from /api/translate's.
  const entry = performance.now();
  const coldStart = !INSTANCE_WARMED;
  INSTANCE_WARMED = true;
  const execRegion = process.env.VERCEL_REGION ?? null;
  const edgeTrace = req.headers.get("x-vercel-id");

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "expected application/json" }, { status: 400 });
  }

  const body = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const text = body.text;
  const targetLang = body.targetLang;

  if (typeof text !== "string") {
    return NextResponse.json(
      { error: "'text' is required and must be a string" },
      { status: 400 },
    );
  }
  if (targetLang !== "ta" && targetLang !== "hi") {
    return NextResponse.json(
      { error: "'targetLang' must be 'ta' or 'hi'" },
      { status: 400 },
    );
  }

  const voiceGenderRaw = body.voiceGender;
  let voiceGender: TtsVoiceGender;
  if (voiceGenderRaw === undefined) {
    // TODO(5): remove this default once the Slice 5 setup UI supplies
    // voiceGender on every request. Gender is a per-speaker registration
    // choice (lib/tts/elevenlabs.ts's synthesiseSpeech), never inferred or
    // defaulted in the long run — this default exists only because no
    // client sends the field yet.
    voiceGender = "female";
  } else if (voiceGenderRaw === "male" || voiceGenderRaw === "female") {
    voiceGender = voiceGenderRaw;
  } else {
    return NextResponse.json(
      { error: "'voiceGender' must be 'male' or 'female'" },
      { status: 400 },
    );
  }

  const requestSent = performance.now();
  const result = await synthesiseSpeech(text, targetLang, voiceGender);
  const responseReceived = performance.now();

  if (!result.ok) {
    const exit = performance.now();
    const debug = buildDebug(
      entry,
      requestSent,
      responseReceived,
      exit,
      coldStart,
      execRegion,
      edgeTrace,
    );
    if (result.reason !== "empty-text") {
      // empty-text is a routine client-input rejection, not an operational
      // problem — don't log it. Never log result.detail: it's the
      // provider's raw diagnostic snippet and may not be safe to persist.
      console.error(`[api/tts] ${result.reason}`);
    }
    // Never forward result.detail to the client — it's the provider's raw
    // diagnostic snippet (could echo request content or provider-internal
    // detail back). Only the reason code and the provider's own status (if
    // any) are safe to return.
    const detail =
      result.status !== null ? `${result.reason} (provider status ${result.status})` : result.reason;
    return NextResponse.json(
      { error: "speech synthesis failed", detail, debug },
      { status: FAILURE_STATUS[result.reason] },
    );
  }

  // No `debug` field on the success path: unlike /api/translate's JSON
  // response, this route's body IS the audio (binary), so there's no
  // envelope to attach a debug key to. Success-path instrumentation
  // (providerFirstAudioByteMs, total bytes/elapsed) instead reaches us via
  // the console.log inside instrumentAudioStream, wrapped around the body
  // below — see that function's comment for why logging is the only option.
  const providerHeadersMs = Math.round(responseReceived - requestSent);
  const audio = instrumentAudioStream(result.audio, {
    entry,
    coldStart,
    providerHeadersMs,
    targetLang,
    voiceGender,
    textLength: text.length,
    execRegion,
  });

  const headers = new Headers({
    // Taken from TtsSuccess, never hardcoded — this route doesn't assume a
    // format (PCM, MP3, or otherwise); lib/tts/elevenlabs.ts owns that.
    "Content-Type": result.contentType,
    // Provider-neutral format identifier (e.g. "mp3"), replacing the old
    // PCM-specific X-Audio-Sample-Rate/Channels/Bit-Depth headers — those
    // described raw PCM and are meaningless now that the locked format is a
    // containerised MP3 (CLAUDE.md -> Stack).
    "X-Audio-Format": result.format,
    "Cache-Control": "no-store",
  });

  // IMPORTANT: returning this Response commits the HTTP status now — Next.js
  // sends status + headers to the client as soon as this function returns,
  // before result.audio has been read to completion. If the ElevenLabs
  // stream fails or truncates mid-flight AFTER this point (synthesiseSpeech
  // already resolved successfully), there is no way to retroactively surface
  // that as an HTTP error status; the client just observes a
  // truncated/short stream. Detecting and handling that case is Slice 4d's
  // concern, not this route's.
  return new Response(audio, { status: result.status, headers });
}
