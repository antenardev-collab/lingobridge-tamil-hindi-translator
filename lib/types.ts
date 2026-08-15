/** Which half of the split screen a turn came from — also the source language. */
export type Side = "ta" | "hi";

/** Where a turn's translate request currently is. */
export type TurnStatus = "loading" | "done" | "error";

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
  /** `x-vercel-id` (region-labelled) off the request; null off Vercel. */
  vercelId: string | null;
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
 * only (locked decision 4). `blob` is the raw WAV, retained per turn. `mimeType`
 * is always "audio/wav"; `durationSec` is wall-clock capture time for the
 * debug-only implied-rate readout (locked decision 6).
 *
 * The request fields fill in as each turn's `/api/translate` call resolves,
 * independently per turn — requests run in parallel, so a later turn can finish
 * before an earlier one. `original` is shown on the speaker's side, `translation`
 * on the listener's side. `requestMs` is the round-trip time; `errorLabel` is a
 * debug marker distinguishing a 400 (capture) from a 502 (model) from a network
 * failure.
 */
export interface Turn {
  id: string;
  side: Side;
  blob: Blob;
  mimeType: string;
  durationSec: number;
  timestamp: number;
  status: TurnStatus;
  original?: string;
  translation?: string;
  requestMs?: number;
  errorLabel?: string;
  /** Slice 4a latency decomposition (client marks + server debug). */
  timing?: TurnTiming;
}
