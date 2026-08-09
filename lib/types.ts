/** Which half of the split screen a turn came from — also the source language. */
export type Side = "ta" | "hi";

/**
 * One captured utterance, held in React session memory only (locked decision 4).
 * `mimeType` records the runtime-selected container so Slice 2 can send the
 * correct content type to OpenRouter without guessing.
 */
export interface Turn {
  id: string;
  side: Side;
  blob: Blob;
  mimeType: string;
  timestamp: number;
}
