/**
 * Canonical 16-bit PCM WAV encoding, shared by the live capture path
 * (lib/recorder.ts) and the off-device round-trip test. Keeping the Int16
 * conversion and header writer here — not inside the worklet — is deliberate:
 * the worklet is a static asset that can't be imported, so siloing the encoder
 * there would make it untestable. The −32768 edge and the asymmetric scaling
 * are exactly the bugs the round-trip test exists to catch, so they must live
 * in importable code.
 *
 * We emit a CANONICAL 44-byte header. The ground-truth test-clips/*.wav were
 * produced by ffmpeg and carry a LIST/INFO chunk (a "Lavf" software tag) that
 * pushes their header to 78 bytes — inert metadata the model ignores. We do not
 * reproduce it: faking encoder provenance in live capture is wrong, and what
 * matters for parity is the PCM stream (16 kHz / mono / 16-bit LE), which is
 * identical.
 */

/** Canonical PCM WAV header length. The clips' 78-byte header is ffmpeg's LIST chunk, not this. */
export const WAV_HEADER_BYTES = 44;

/**
 * Float32 [-1, 1] → Int16 PCM, clamped then scaled asymmetrically: negatives by
 * 0x8000 (32768), positives by 0x7FFF (32767). This uses the full int16 range in
 * both directions so loud speech isn't clipped — a distortion that is inaudible
 * on a desktop monitor but audible on a phone speaker. Clamp BEFORE scaling so a
 * sample just past −1 lands on −32768 exactly and never overflows.
 */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/**
 * Wrap Int16 mono PCM in a canonical 44-byte WAV/RIFF header. Little-endian
 * throughout — the format the endpoint's RIFF/WAVE check and both providers expect.
 */
export function encodeWav(pcm: Int16Array, sampleRate: number): ArrayBuffer {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // ChunkSize = 36 + data
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size for PCM
  view.setUint16(20, 1, true); // AudioFormat = PCM
  view.setUint16(22, 1, true); // NumChannels = mono
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate = rate * channels(1) * bytesPerSample(2)
  view.setUint16(32, 2, true); // BlockAlign = channels(1) * bytesPerSample(2)
  view.setUint16(34, 16, true); // BitsPerSample
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true); // Subchunk2Size

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < pcm.length; i++, offset += 2) {
    view.setInt16(offset, pcm[i], true);
  }
  return buf;
}
