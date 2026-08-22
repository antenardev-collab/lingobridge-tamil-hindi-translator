import type { AmplitudeReading } from "./recorder";

/** Which half of the split screen a turn came from — also the source language. */
export type Side = "ta" | "hi";

/**
 * Slice 4a latency decomposition, returned by /api/translate under `debug`.
 *
 * CLOCK DISCIPLINE (critical): every field here is a duration in ms between two
 * marks taken from the SERVER's clock (Node `performance.now()`, one process).
 * These are never subtracted against client marks — the two clocks are not
 * synchronised. The ONE valid cross-clock derivation is transport =
 * (client encoded→complete) − `serverTotalMs`: a same-clock duration minus a
 * same-clock duration.
 */
export interface ServerDebug {
  /** First invocation of this warm function instance (module-scope flag). */
  coldStart: boolean;
  /**
   * `process.env.VERCEL_REGION` — Vercel's own docs: "The ID of the Region
   * where the app is running" (runtime-only). The AUTHORITATIVE execution
   * region. Null off Vercel, or if System Environment Variables access isn't
   * enabled for the project.
   */
  execRegion: string | null;
  /**
   * Raw `x-vercel-id` request header, verbatim, UNPARSED. Per Vercel's docs this
   * header accumulates region hops as the request travels and is edge-appended
   * BEFORE the function executes — so a request-side read is the edge PoP
   * nearest the caller, NOT the execution region. Named `edgeTrace` (not
   * `vercelId`) specifically so it can't be mistaken for `execRegion` again —
   * that mistake already produced one wrong regional conclusion this project.
   */
  edgeTrace: string | null;
  /**
   * Does OUR code stream this provider call? Names the implementation, not the
   * model's capability (the model supports streaming — we don't use it here). The
   * current `generateContent` call is not streamed, so this is false,
   * `requestToFirstByteMs` is null, and we report complete-time rather than
   * inventing a first-byte number.
   */
  weStream: boolean;
  /** entry → just before the provider fetch (function setup cost). */
  entryToRequestMs: number;
  /**
   * request → provider response headers. Null while we don't stream: for
   * `generateContent` the model computes the whole reply before the HTTP
   * response opens, so header-arrival is not a token TTFT and we do not fake one.
   */
  requestToFirstByteMs: number | null;
  /** request → provider body fully read. Complete-time (reported because we don't stream). */
  requestToCompleteMs: number;
  /** provider complete → exit (parse / validate / serialise). */
  completeToExitMs: number;
  /**
   * entry → exit, measured DIRECTLY (not summed from the parts) so it can expose
   * unaccounted time. The client subtracts THIS from its own encoded→complete to
   * derive transport — the only sanctioned cross-clock join.
   */
  serverTotalMs: number;
  /**
   * serverTotalMs − (entryToRequestMs + requestToCompleteMs + completeToExitMs).
   * Time inside the function not captured by the three named intervals (plus
   * per-field rounding). A non-trivial value means a mark is missing.
   */
  residualMs: number;
  /**
   * Slice 4a+ fine-grained decomposition of requestToCompleteMs, present only
   * when the pipeline populated a ProviderTrace (gemini-direct today).
   * Deliberately OPTIONAL rather than defaulted to a zeroed object: an absent
   * trace (no pipeline support, or the call errored before returning marks)
   * must not look the same as a trace whose deltas happen to be zero.
   */
  providerTrace?: ServerProviderTrace;
  /**
   * Slice 4d: duration parsed from the WAV bytes (lib/wav.ts), or null if it
   * couldn't be determined. Populated on both the success and error paths —
   * lets a probe run verify the duration parse is correct without another
   * deploy.
   */
  audioDurationSec?: number | null;
  /** Slice 4d: the timeout deadline (ms) applied to this request's Gemini call. */
  deadlineMs?: number;
  /**
   * Slice 4d: "measured" when deadlineMs was derived from the server's own
   * WAV parse (audioDurationSec) — this meaning is unchanged from the
   * original single-tier version, so historical results stay comparable.
   * "client-hint" (step 2) when the server's own parse failed/was
   * implausible but the client-supplied durationSec hint was usable
   * instead. "fallback" when neither was usable and the fixed fallback
   * deadline was used.
   */
  deadlineSource?: "measured" | "client-hint" | "fallback";
}

/**
 * Rounded millisecond deltas from one ProviderTrace, plus its passthrough
 * response metadata. All deltas are on the SAME server clock as the rest of
 * ServerDebug (never mixed with the client's clock).
 */
export interface ServerProviderTrace {
  /**
   * payloadReady − requestSent: our own cost of building the request body
   * string. Previously this time was counted as provider latency (folded
   * into requestToCompleteMs) — this pulls it out as a named cost.
   */
  serialiseMs: number;
  /**
   * fetchStart − payloadReady. Expected near zero; a non-trivial value means
   * something unaccounted sits between serialisation and the fetch call.
   */
  preFetchMs: number;
  /**
   * headers − fetchStart. Covers upload + queueing + inference +
   * time-to-first-response-byte together — NOT separable further from inside
   * the function (this is a non-streaming call; there is no earlier mark to
   * split it against).
   */
  fetchToHeadersMs: number;
  /** bodyRead − headers: time to read the response body as text. */
  bodyDownloadMs: number;
  /** parsed − bodyRead: JSON.parse cost. */
  parseMs: number;
  /**
   * requestToCompleteMs − (serialiseMs + preFetchMs + fetchToHeadersMs +
   * bodyDownloadMs + parseMs). Mirrors residualMs above: a non-trivial value
   * means a mark is missing.
   */
  traceResidualMs: number;
  /** Byte length of the serialised request body. */
  requestBytes: number;
  /** Byte length of the response body text. */
  responseBytes: number;
  /** 1 for the first Gemini call this process instance made, incrementing thereafter. */
  callIndexInProcess: number;
  /** candidates[0].finishReason. Null if absent from the response. */
  finishReason: string | null;
  /** Gemini's modelVersion field. Null if absent from the response. */
  modelVersion: string | null;
  /** Gemini's responseId field. Null if absent from the response. */
  responseId: string | null;
  /** modelStatus.modelStage. Null if absent from the response. */
  modelStage: string | null;
  /** usageMetadata.serviceTier. Null if absent from the response. */
  serviceTier: string | null;
  /** usageMetadata.totalTokenCount. Null means absent — distinct from a real 0. */
  totalTokens: number | null;
  /** usageMetadata.thoughtsTokenCount. Null means absent — distinct from a real 0. */
  thoughtsTokens: number | null;
}

/**
 * Slice 4a per-turn timing, held in session memory alongside the turn. Client
 * marks are `performance.now()` on the CLIENT clock only; `server` carries the
 * server-clock decomposition from the response body. Never subtract a client
 * mark from a server mark.
 */
export interface TurnTiming {
  /** pointerup. */
  release: number;
  /** WAV encode complete, immediately before fetch(). */
  encoded: number;
  /** response headers received (fetch promise resolved). */
  firstByte: number;
  /** response body fully read. */
  complete: number;
  /** WAV payload size posted. */
  payloadBytes: number;
  /** First turn since page load. */
  firstTurn: boolean;
  /** Seconds since the previous turn's release; null on the first turn (the idle gap). */
  sinceLastReleaseSec: number | null;
  /** Server-clock decomposition; null if the response carried no `debug`. */
  server: ServerDebug | null;
}

/**
 * One captured utterance + its translate result, held in React session memory
 * only (locked decision 4 — raw audio retained per turn). `blob` is the raw
 * WAV; `mimeType` is always "audio/wav"; `durationSec` is wall-clock capture
 * time for the debug-only implied-rate readout (locked decision 6). All three
 * are REQUIRED, not optional: a CapturedTurn only ever exists because audio
 * was actually captured and encoded (lib/recorder.ts's MIN_TURN_MS gate
 * returns a SkippedTurn instead, below, when that didn't happen) — decision 4
 * as a compiler-enforced invariant, not just a comment.
 *
 * The request fields fill in as each turn's `/api/translate` call resolves,
 * independently per turn — requests run in parallel, so a later turn can finish
 * before an earlier one. `original` is shown on the speaker's side, `translation`
 * on the listener's side. `requestMs` is the round-trip time; `errorLabel` is a
 * debug marker distinguishing a 400 (capture) from a 502 (model) from a network
 * failure.
 */
export interface CapturedTurn {
  id: string;
  side: Side;
  status: "loading" | "done" | "error";
  blob: Blob;
  mimeType: string;
  durationSec: number;
  timestamp: number;
  original?: string;
  translation?: string;
  requestMs?: number;
  errorLabel?: string;
  /** Slice 4a latency decomposition (client marks + server debug). */
  timing?: TurnTiming;
  /** TEMPORARY — 4b.2 amplitude readout (see lib/recorder.ts). Descriptive only
   * on a CapturedTurn: this turn already cleared both gates, so the value here
   * doesn't drive any decision — it's the same measurement the energy gate
   * used, kept for visibility on turns that passed. */
  amplitude: AmplitudeReading;
}

/**
 * A release that never became a turn — it tripped one of the two 4b.2
 * insufficiency checks in `CaptureEngine.stopRecording()` (duration or
 * energy), so nothing was encoded and nothing was sent. No audio fields
 * exist on this variant at all: there is no blob to retain, so decision 4
 * (raw-audio retention) doesn't apply and can't be reached for.
 * `gatedSamples`/`gatedImpliedMs` are the evidence a duration trip acted on;
 * `gatedRmsDbfs` is the evidence an energy trip acted on. Both are kept for
 * the debug row and the copy-timings export so trip frequency — and, for
 * energy trips, how close to the threshold — can be counted offline.
 */
export interface SkippedTurn {
  id: string;
  side: Side;
  status: "gated";
  timestamp: number;
  gatedSamples: number;
  gatedImpliedMs: number;
  /** Which check tripped: duration (4b.2) or energy (4b.2 extension). */
  gatedReason: "duration" | "energy";
  /** Measured RMS dBFS — set only when `gatedReason` is "energy". */
  gatedRmsDbfs?: number;
}

/** A turn-list entry: either a real captured/sent turn, or a gate trip. */
export type Turn = CapturedTurn | SkippedTurn;
