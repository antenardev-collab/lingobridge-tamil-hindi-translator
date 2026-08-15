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
  /** TEMPORARY — 4b.2 energy-gate measurement (see lib/recorder.ts). Not used for gating. */
  amplitude: AmplitudeReading;
}

/**
 * A release that never became a turn — the captured sample count fell below
 * MIN_TURN_MS (lib/recorder.ts), so nothing was encoded and nothing was sent.
 * No audio fields exist on this variant at all: there is no blob to retain,
 * so decision 4 (raw-audio retention) doesn't apply and can't be reached for.
 * `gatedSamples`/`gatedImpliedMs` are the evidence the gate acted on, kept for
 * the debug row and the copy-timings export so trip frequency can be counted.
 */
export interface SkippedTurn {
  id: string;
  side: Side;
  status: "gated";
  timestamp: number;
  gatedSamples: number;
  gatedImpliedMs: number;
}

/** A turn-list entry: either a real captured/sent turn, or a gate trip. */
export type Turn = CapturedTurn | SkippedTurn;
