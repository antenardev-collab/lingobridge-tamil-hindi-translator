import type { CaptureEngine } from "./recorder";
import { UNMUTE_DELAY_MS } from "./tts/playback";
import type { Side } from "./types";

/**
 * Failure sounds (Slice 4d): a short tone on any failed turn, plus a spoken
 * message when the same speaker fails twice consecutively.
 *
 * Deliberately reuses <audio> playback and CaptureEngine.mute()/unmute() —
 * the exact gating sequence lib/tts/playback.ts's speak() uses — rather than
 * synthesising a tone through the capture AudioContext. Three reasons:
 * CaptureEngine is the Slice 3 persistent-engine fix and stays a capture
 * engine with no playback duties; opening a second AudioContext on Android
 * Chrome risks the audio-graph churn Slice 3 eliminated; and the
 * second-failure message is necessarily a file (fail-ta.mp3/fail-hi.mp3), so
 * a synthesised tone would mean two playback mechanisms and two gating
 * implementations where one already does the job.
 *
 * Never throws. This runs when a turn has already failed — it must not
 * become a second failure. Any load/play error simply releases the gate and
 * returns.
 */

const TONE_URL = "/audio/fail-tone.mp3";
const MESSAGE_URL: Record<Side, string> = {
  ta: "/audio/fail-ta.mp3",
  hi: "/audio/fail-hi.mp3",
};

/**
 * Plays the failure tone for `side`, and — when `withMessage` is true — the
 * spoken failure message for that side immediately after the tone ends.
 * Gates `engine` as ONE span across both sounds: `mute()` before the tone's
 * `play()` (mirroring speak()'s mute-before-play ordering exactly), and
 * `unmute()` exactly UNMUTE_DELAY_MS after the LAST sound in the sequence
 * finishes — never between the tone and the message, since a mic that opens
 * in that gap could capture the message's own leading edge through the
 * speaker. A single `claimed` guard (same pattern as speak()'s
 * settleAfterRelease) ensures the gate is released exactly once, however the
 * sequence ends: tone success into message, tone error, tone play()
 * rejection, message error, or message play() rejection.
 */
export async function playFailureAudio(
  side: Side,
  withMessage: boolean,
  engine: CaptureEngine,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let claimed = false;

    function settleAfterRelease() {
      if (claimed) return;
      claimed = true;
      setTimeout(() => {
        engine.unmute();
        resolve();
      }, UNMUTE_DELAY_MS);
    }

    function playMessage() {
      const message = new Audio();
      message.src = MESSAGE_URL[side];
      message.onended = () => settleAfterRelease();
      message.onerror = () => settleAfterRelease();
      message.play().catch(() => settleAfterRelease());
    }

    const tone = new Audio();
    tone.src = TONE_URL;
    tone.onended = () => {
      if (withMessage) {
        playMessage();
      } else {
        settleAfterRelease();
      }
    };
    tone.onerror = () => settleAfterRelease();

    // Engage the gate immediately before play(), not after it resolves —
    // same reasoning as speak(): play()'s returned promise resolves AFTER
    // playback has already begun, so gating on resolution would leave a
    // window where the tone is audible to the microphone before the gate
    // engages.
    engine.mute();
    tone.play().catch(() => settleAfterRelease());
  });
}
