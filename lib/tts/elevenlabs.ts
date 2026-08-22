/**
 * ElevenLabs streaming TTS (Leg 2, CLAUDE.md -> Stack). This is the ONLY
 * module in the app that may reference ElevenLabs — a future provider swap
 * replaces this file's internals only. Everything downstream depends on
 * TtsResult/TtsSuccess/TtsFailure below, never on ElevenLabs directly; those
 * exported types must stay provider-neutral.
 *
 * Timeout handling (Slice 4d step 2): synthesiseSpeech() accepts an
 * optional AbortSignal and passes it straight through to the provider
 * fetch — an aborted call returns TtsFailure{reason:"aborted"} rather than
 * hanging. This module enforces no deadline of its own; the caller decides
 * whether and when to abort. (No caller passes one yet — app/api/tts/route.ts
 * is unchanged this step — but the plumbing exists for when one does.) The
 * client-side fetch/read timeout and the play()-stall watchdog both live in
 * lib/tts/playback.ts, not here.
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

/**
 * Voice gender for synthesis. Follows the SPEAKER, not the translation
 * direction — see the `gender` parameter comment on synthesiseSpeech below
 * for the full reasoning and docs/PLAN.md -> Slice 6 for the source
 * decision.
 */
export type TtsVoiceGender = "male" | "female";

// Locked model. ElevenLabs' own sample code defaults to
// eleven_multilingual_v2 — slower and twice the price. Never use it here;
// model_id must always be set explicitly to this constant.
const MODEL_ID = "eleven_flash_v2_5";

// Voice Library ("professional" category) voices — require a paid
// ElevenLabs plan for API access (account is on Starter; see CLAUDE.md ->
// Stack). Keyed by [TtsTargetLang][TtsVoiceGender]: voice gender must be a
// function of the SPEAKER, not of translation direction, so a single
// voice-per-language table (the shape this replaced) is wrong by
// construction — it made gender a side effect of which way the audio was
// going, not who was speaking.
const VOICE_IDS: Record<TtsTargetLang, Record<TtsVoiceGender, string>> = {
  ta: {
    female: "wLIQpmGi7jT7aiEmDsE3", // Janani
    male: "NsQE1nARp8lz1QelRCh9", // Rajan
  },
  hi: {
    female: "gHu9GtaHOXcSqFTK06ux", // Anjali
    male: "35h4XgJYQYdHtGbOCg7x", // Rohit
  },
};

// Output format is MP3, not PCM — PCM was the original choice, made for a
// chunk-scheduled playback path, and was rejected on measurement (see
// docs/PLAN.md -> Slice 4, "Client playback format": chunking could save at
// most 15-245ms server-side while PCM ran 3x-12x the payload of MP3 on the
// dominant, noisiest leg). Client playback now fetches the complete response
// and plays it, so the smaller MP3 payload is strictly better with no
// latency downside.
const OUTPUT_FORMAT = "mp3_44100_128";
const CONTENT_TYPE = "audio/mpeg";
const FORMAT_ID = "mp3";

const BASE = "https://api.elevenlabs.io/v1/text-to-speech";

/**
 * Streamed audio, ready to relay to the caller unbuffered. Deliberately
 * format-agnostic: `contentType` is the exact value a caller should set as
 * an HTTP Content-Type header, and `format` is a short provider-neutral
 * identifier (e.g. "mp3") a caller can branch or log on without parsing
 * `contentType`. This replaces the previous PCM-specific
 * sampleRate/channels/bitDepth fields, which were meaningless for a
 * containerised format like MP3 and forced every caller to assume raw PCM.
 * A future provider returning PCM describes it through these SAME two
 * fields (e.g. contentType: "audio/L16;rate=24000", format: "pcm16") — the
 * union stays provider-neutral either way.
 */
export interface TtsSuccess {
  ok: true;
  audio: ReadableStream<Uint8Array>;
  contentType: string;
  format: string;
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
  /**
   * `aborted` (Slice 4d step 2) is deliberately distinct from
   * `network-error`: `network-error` means the fetch to the provider
   * failed on its own (DNS, connection refused, transport error);
   * `aborted` means WE gave up via the caller's AbortSignal — a different
   * cause, useful to tell apart when diagnosing a timeout policy.
   */
  reason: "missing-api-key" | "empty-text" | "network-error" | "http-error" | "aborted";
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
 *
 * `gender` is REQUIRED, deliberately with no default: gender follows the
 * SPEAKER, not the translation direction (a wrong language is confusing and
 * recoverable; a wrong gender is personal and spoken aloud), and it is
 * selected at speaker setup, not inferred from the audio signal — see
 * docs/PLAN.md -> Slice 6. Omitting a default here means a gender-blind call
 * site is a COMPILE error, not a silent coin flip. The setup UI where a
 * speaker actually chooses their gender is Slice 5 and doesn't exist yet;
 * until it does, callers must still pass an explicit value (the route layer
 * owns whatever placeholder default is needed meanwhile — see
 * app/api/tts/route.ts). The per-language/per-gender VOICE_IDS table above
 * is the PERMANENT fallback path for any speaker without a cloned voice, not
 * a temporary measure to be removed once cloning ships.
 */
export async function synthesiseSpeech(
  text: string,
  targetLang: TtsTargetLang,
  gender: TtsVoiceGender,
  signal?: AbortSignal,
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

  const voiceId = VOICE_IDS[targetLang][gender];
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
      signal,
    });
  } catch (err) {
    const aborted =
      typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
    return {
      ok: false,
      reason: aborted ? "aborted" : "network-error",
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
    contentType: CONTENT_TYPE,
    format: FORMAT_ID,
    status: res.status,
  };
}
