import type { CaptureEngine } from "./recorder";
import { UNMUTE_DELAY_MS } from "./tts/playback";
import type { Side } from "./types";

/**
 * Failure sounds (Slice 4d): three-tier escalation on repeated failure.
 * Tier 1 — any failure: tone only. Tier 2 — that speaker's second
 * consecutive failure: tone, then the spoken per-speaker message
 * (fail-ta.mp3/fail-hi.mp3). Tier 3 — the third consecutive failure
 * counted GLOBALLY across both sides (the service itself, not just this
 * speaker, is down): tone, then a distinct message (down-ta.mp3/
 * down-hi.mp3) in the language of whoever just failed. Tier selection and
 * both counters live in app/page.tsx; this module only knows how to play
 * whichever tier it's told.
 *
 * Deliberately reuses <audio> playback and CaptureEngine.mute()/unmute() —
 * the exact gating sequence lib/tts/playback.ts's speak() uses — rather than
 * synthesising a tone through the capture AudioContext. Three reasons:
 * CaptureEngine is the Slice 3 persistent-engine fix and stays a capture
 * engine with no playback duties; opening a second AudioContext on Android
 * Chrome risks the audio-graph churn Slice 3 eliminated; and the tier 2/3
 * messages are necessarily files, so a synthesised tone would mean two
 * playback mechanisms and two gating implementations where one already does
 * the job.
 *
 * Never throws. This runs when a turn has already failed — it must not
 * become a second failure. Any load/play error simply releases the gate and
 * returns.
 */

/** Which escalation tier to play. See the module comment above for the rule. */
export type FailureTier = 1 | 2 | 3;

const TONE_URL = "/audio/fail-tone.mp3";
const MESSAGE_URL: Record<Side, string> = {
  ta: "/audio/fail-ta.mp3",
  hi: "/audio/fail-hi.mp3",
};
const DOWN_URL: Record<Side, string> = {
  ta: "/audio/down-ta.mp3",
  hi: "/audio/down-hi.mp3",
};

/**
 * Plays the failure tone for `side`, then — depending on `tier` — nothing
 * more (tier 1), the per-speaker fail message (tier 2), or the service-down
 * message (tier 3), in that speaker's language either way. Gates `engine` as
 * ONE span across both sounds: `mute()` before the tone's `play()`
 * (mirroring speak()'s mute-before-play ordering exactly), and `unmute()`
 * exactly UNMUTE_DELAY_MS after the LAST sound in the sequence finishes —
 * never between the tone and the second sound, since a mic that opens in
 * that gap could capture the second sound's own leading edge through the
 * speaker. A single `claimed` guard (same pattern as speak()'s
 * settleAfterRelease) ensures the gate is released exactly once, however the
 * sequence ends: tone success into a second sound, tone error, tone play()
 * rejection, second-sound error, or second-sound play() rejection. This is
 * the SAME gating structure as before tiers existed — only which URL plays
 * second has changed.
 */
export async function playFailureAudio(
  side: Side,
  tier: FailureTier,
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

    function playSecondSound(url: string) {
      const sound = new Audio();
      sound.src = url;
      sound.onended = () => settleAfterRelease();
      sound.onerror = () => settleAfterRelease();
      sound.play().catch(() => settleAfterRelease());
    }

    const tone = new Audio();
    tone.src = TONE_URL;
    tone.onended = () => {
      if (tier === 2) {
        playSecondSound(MESSAGE_URL[side]);
      } else if (tier === 3) {
        playSecondSound(DOWN_URL[side]);
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
