# Build Plan

Six slices. Each is roughly one Claude Code session and ends with something you
can open on a phone and judge. Commit after every green slice. Use plan mode
(Shift+Tab twice) before starting each one — read the proposed approach and
correct it before any code exists.

Do not start a slice until the previous one works on a real device.

---

## Slice 1 — Shell and capture

**Goal:** two halves, two buttons, audio blobs in memory. No AI yet.

> Scaffold a Next.js + TypeScript app. Single page, split vertically: top half
> Tamil (labelled in Tamil script), bottom half Hindi (labelled in Devanagari).
> Each half has a large hold-to-talk button — at least 44px tall, thumb-reachable,
> works with `pointerdown`/`pointerup` so it behaves on touch. Recording uses
> MediaRecorder with `echoCancellation: true` and `noiseSuppression: true`.
> On release, store the blob in a React session array as
> `{ id, side: 'ta' | 'hi', blob, timestamp }` and render the blob size on screen
> so I can confirm capture worked. No API calls. Handle mic permission denial
> with a clear message in all three languages.

**Done when:** you hold each button on a real phone and see a plausible byte
count. If you see 0 bytes, it's the MediaRecorder mimeType — Android Chrome and
iOS Safari disagree; pick a supported type at runtime.

---

## Slice 2 — The translate endpoint

**Goal:** a proven core you can test without any UI.

> Add `POST /api/translate`. It accepts an audio blob plus a `sourceLang` field
> of `ta` or `hi`. Base64-encode the audio and send one call to OpenRouter
> `/api/v1/chat/completions` using the `input_audio` content type, with a model
> from `lib/models.ts`. The prompt instructs the model to transcribe the audio in
> the given source language and translate to the other one, returning only JSON:
> `{ original, translation }`. Strip markdown fences, parse, validate the shape,
> and return typed JSON. On malformed output, retry once, then return a
> structured error. Key stays server-side. Also add a `npm run eval` script that
> posts every `.wav` in `test-clips/` to the endpoint and prints a table of
> input filename, original, translation, and elapsed ms.

**Done when:** `npm run eval` returns sane translations. Before this,
**record ~20 real clips** — actual shop conversations, not you reading
sentences. Prices, sizes, "adjust pannunga", "kitna hoga", code-mixed English
nouns. This set is what tells you whether a model swap is better or worse.

---

## Slice 3 — Wire it up

> Connect each half's button to `/api/translate` with the correct `sourceLang`.
> Show the original on the speaker's side and the translation on the listener's
> side, in that side's script, at large readable size. Add per-side loading and
> error states. The translation must be re-tappable to replay. Keep the raw blob
> in session memory alongside the result.

**Done when:** two people can hold a conversation by tapping. This is already a
usable product — try it in a real shop before moving on.

---

## Slice 4 — Voice output

> Add TTS via OpenRouter `/api/v1/audio/speech` behind `POST /api/speak`.
> Autoplay the translation on the listener's side. **Before playback starts,
> hard-mute the mic stream; unmute 250ms after the `ended` event.** Add a
> replay button. If TTS fails, the text stays on screen — never block on audio.

**Done when:** audio plays and mic mute/unmute is verifiable in the console.
Benchmark Tamil and Hindi voice quality across the available TTS models — this
is where they differ most, and Tamil is usually the weaker one.

---

## Slice 5 — Hands-free toggle

**The risky slice.** Everything before this is your fallback.

> Add a hands-free toggle. When on: continuous mic with VAD-based turn
> segmentation, mic hard-gated during TTS playback, and language routing that
> falls back to whichever side was last tapped when detection is low-confidence.
> Add a semantic guard — if a new transcription is >90% similar to the last
> thing we spoke, drop it silently. Tap-to-talk remains available at all times
> and takes priority. Log every segment decision so I can debug why a turn fired
> or didn't.

**Done when:** it survives 10 minutes in a noisy room without a runaway loop.
Tune the VAD threshold against recordings from the actual environment, not a
quiet room. If it can't be made reliable, ship slices 1–4 and say so.

---

## Slice 6 — Speaker attribution

> Add speaker enrollment. During normal tap-to-talk use, build a voice embedding
> per side from the stored session audio. In hands-free mode, use speaker
> identity to route language (voice A = Hindi, voice B = Tamil) instead of
> detecting language from content, and to ignore segments matching neither
> enrolled speaker.

This is what makes the boutique case work — it stops bystanders and the TV from
being translated into the middle of a negotiation, and it makes one-word turns
unambiguous. Enrollment falls out of slices 1–4 for free.

---

## Session hygiene

- One slice per session. Long sessions drift.
- Commit working code before starting the next slice.
- When you correct Claude Code on something that will recur, put it in
  `CLAUDE.md` rather than repeating it next session.
- Keep `CLAUDE.md` short. If it grows past ~100 lines, move detail into
  `.claude/rules/` files.
