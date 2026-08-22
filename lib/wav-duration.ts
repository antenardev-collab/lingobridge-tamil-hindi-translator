/**
 * WAV duration parsing (Slice 4d). Server-only — parses a WAV header to
 * derive the /api/translate timeout deadline from the audio itself, rather
 * than from a client-supplied duration the server cannot verify. Takes a
 * Node `Buffer`, so this must NOT be imported by any client module (that
 * would put a Node global into the browser bundle) — in particular, keep it
 * separate from lib/wav.ts, which lib/recorder.ts (a browser module) imports.
 */

interface WavFmt {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
}

/**
 * Duration in seconds of a WAV buffer, or `null` if it cannot be determined
 * — truncated buffer, missing `fmt `/`data` chunk, zero sample rate, zero
 * byte rate. Never throws.
 *
 * Walks the chunk list rather than assuming a fixed 44-byte header — a
 * `LIST` or `fact` chunk before `data` would give a wrong duration
 * otherwise (the corpus clips carry a 78-byte ffmpeg `LIST/INFO` header, not
 * a canonical 44-byte one — see lib/wav.ts).
 */
export function getWavDurationSec(buf: Buffer): number | null {
  if (buf.length < 12) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let fmt: WavFmt | null = null;
  let dataBytes: number | null = null;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (bodyStart + chunkSize > buf.length) break; // truncated chunk — stop walking

    if (chunkId === "fmt " && chunkSize >= 16) {
      fmt = {
        numChannels: buf.readUInt16LE(bodyStart + 2),
        sampleRate: buf.readUInt32LE(bodyStart + 4),
        bitsPerSample: buf.readUInt16LE(bodyStart + 14),
      };
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    }

    offset = bodyStart + chunkSize + (chunkSize % 2); // chunks are padded to even size
  }

  if (!fmt || dataBytes === null) return null;
  if (fmt.sampleRate <= 0 || fmt.numChannels <= 0 || fmt.bitsPerSample <= 0) return null;

  const byteRate = fmt.sampleRate * fmt.numChannels * (fmt.bitsPerSample / 8);
  if (byteRate <= 0) return null;

  return dataBytes / byteRate;
}
