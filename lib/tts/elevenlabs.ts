/**
 * ElevenLabs streaming TTS (Leg 2, CLAUDE.md -> Stack). This is the ONLY
 * module in the app that may reference ElevenLabs — a future provider swap
 * replaces this file's internals only. Everything downstream depends on
 * TtsResult/TtsSuccess/TtsFailure below, never on ElevenLabs directly; those
 * exported types must stay provider-neutral.
 *
 * TODO(4d): no timeout, no AbortSignal — a hung request currently hangs
 * indefinitely. Timeout-and-abandon policy is owned by Slice 4d (see
 * docs/PLAN.md), not this module.
 */

/**
 * The OUTPUT language of synthesis. Deliberately a separate type from
 * `Side` (lib/types.ts), even though both are "ta" | "hi" — `Side` is the
 * SPEAKER's side, and the two are opposite in every turn (Tamil speech
 * synthesises Hindi audio and vice versa). Sharing one type would let a
 * caller pass the speaker's side where the target language is required and
 * have it type-check while being backwards.
 */
export type TtsTargetLang = "ta" | "hi";

// Locked model. ElevenLabs' own sample code defaults to
// eleven_multilingual_v2 — slower and twice the price. Never use it here;
// model_id must always be set explicitly to this constant.
const MODEL_ID = "eleven_flash_v2_5";

// Voice Library ("professional" category) voices — require a paid
// ElevenLabs plan for API access (account is on Starter; see CLAUDE.md ->
// Stack). Keyed by TtsTargetLang, the OUTPUT language of synthesis.
const VOICE_IDS: Record<TtsTargetLang, string> = {
  ta: "wLIQpmGi7jT7aiEmDsE3", // Janani
  hi: "35h4XgJYQYdHtGbOCg7x", // Rohit
};

const OUTPUT_FORMAT = "pcm_24000";
const PCM_SAMPLE_RATE = 24000;
const PCM_CHANNELS = 1;
const PCM_BIT_DEPTH = 16;

const BASE = "https://api.elevenlabs.io/v1/text-to-speech";

/** Streamed PCM audio, ready to relay to the caller unbuffered. */
export interface TtsSuccess {
  ok: true;
  audio: ReadableStream<Uint8Array>;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  status: number;
}

/**
 * No audio produced. `reason` distinguishes the failure class so a caller
 * can react without string-matching `detail`. `status` is the HTTP status
 * where one exists (null for a missing key or a transport failure that never
 * got a response). `detail` is diagnostic only — for `http-error` it's the
 * first 500 characters of the response body; it never contains the API key.
 */
export interface TtsFailure {
  ok: false;
  reason: "missing-api-key" | "empty-text" | "network-error" | "http-error";
  status: number | null;
  detail: string;
}

/** Discriminated on `ok`, mirroring the CapturedTurn | SkippedTurn pattern in lib/types.ts. */
export type TtsResult = TtsSuccess | TtsFailure;

/**
 * Synthesise `text` in `targetLang` via ElevenLabs streaming TTS. Fail-fast:
 * no retries, no backoff — that belongs to the caller. Returns the response
 * body stream directly; never buffers it (no arrayBuffer()), so the caller
 * gets the real streaming benefit.
 */
export async function synthesiseSpeech(
  text: string,
  targetLang: TtsTargetLang,
): Promise<TtsResult> {
  // Empty/whitespace-only input never reaches the network. Returning an
  // empty audio stream would degrade toward silence — the project's
  // fallback principle (CLAUDE.md/docs/PLAN.md: fail loud, never a silent
  // degraded output) forbids that, so this is a hard failure, not a no-op.
  if (!text.trim()) {
    return {
      ok: false,
      reason: "empty-text",
      status: null,
      detail: "text is empty or whitespace-only",
    };
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      reason: "missing-api-key",
      status: null,
      detail: "ELEVENLABS_API_KEY is not set",
    };
  }

  const voiceId = VOICE_IDS[targetLang];
  const endpoint = `${BASE}/${voiceId}/stream?output_format=${OUTPUT_FORMAT}`;
  const body = { text, model_id: MODEL_ID, language_code: targetLang };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      reason: "network-error",
      status: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (res.status !== 200) {
    const bodyText = await res.text();
    return { ok: false, reason: "http-error", status: res.status, detail: bodyText.slice(0, 500) };
  }

  if (!res.body) {
    // Should not happen on a 200 from this endpoint; kept for strict-null
    // soundness rather than asserting the stream non-null.
    return { ok: false, reason: "http-error", status: res.status, detail: "200 response had no body" };
  }

  return {
    ok: true,
    audio: res.body,
    sampleRate: PCM_SAMPLE_RATE,
    channels: PCM_CHANNELS,
    bitDepth: PCM_BIT_DEPTH,
    status: res.status,
  };
}
