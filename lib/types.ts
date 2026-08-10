/** Which half of the split screen a turn came from — also the source language. */
export type Side = "ta" | "hi";

/** Where a turn's translate request currently is. */
export type TurnStatus = "loading" | "done" | "error";

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
}
