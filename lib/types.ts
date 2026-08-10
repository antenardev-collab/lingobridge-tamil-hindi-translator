/** Which half of the split screen a turn came from — also the source language. */
export type Side = "ta" | "hi";

/**
 * One captured utterance, held in React session memory only (locked decision 4).
 * `mimeType` is now always "audio/wav" (single WAV capture path); it's retained
 * for a stable shape. `durationSec` is wall-clock capture time, used only for the
 * debug-only implied-sample-rate readout (locked decision 6).
 */
export interface Turn {
  id: string;
  side: Side;
  blob: Blob;
  mimeType: string;
  durationSec: number;
  timestamp: number;
}
