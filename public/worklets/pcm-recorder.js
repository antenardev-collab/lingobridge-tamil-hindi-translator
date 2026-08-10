/**
 * PCM recorder AudioWorklet processor.
 *
 * Runs in AudioWorkletGlobalScope and is served as a STATIC asset, loaded via
 * audioWorklet.addModule('/worklets/pcm-recorder.js'). It cannot be a bundled
 * import — the worklet loader fetches this file directly, and Next.js/webpack
 * would not produce something fetchable at a stable URL. public/ is served at
 * the site root by Next on Vercel, so this path is stable in production.
 *
 * The processor does ONE job: framing. It copies each render quantum's mono
 * Float32 samples and posts them to the main thread, which does Float32→Int16
 * and the WAV header (lib/wav.ts) so that encoder code stays unit-testable
 * off-device. Because the AudioContext runs at 16000 Hz, the samples arriving
 * here are already resampled to 16 kHz by the source node (verified on-device);
 * this file does no resampling and no filtering.
 *
 * Output is left silent. The node is connected to the destination only to keep
 * process() reliably pulled on Android Chrome — we never copy the mic to the
 * output, so there is no feedback.
 */
class PcmRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel && channel.length) {
      // The render buffer is reused each quantum, so post a copy, not the view.
      // Transfer the copy's buffer to hand ownership to the main thread cheaply.
      const copy = new Float32Array(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    // Keep the processor alive until the node is disconnected / context closed.
    return true;
  }
}

registerProcessor("pcm-recorder", PcmRecorder);
