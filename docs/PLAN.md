# Build Plan

Six slices. Each is roughly one Claude Code session and ends with something you
can open on a phone and judge. Commit after every green slice. Use plan mode
(Shift+Tab twice) before starting each one — read the proposed approach and
correct it before any code exists.

Do not start a slice until the previous one works on a real device.

## Assets already in place

- `test-clips/ground-truth.json` — 26 entries, 13 Tamil source + 13 Hindi source
- `test-clips/*.wav` — 16kHz mono PCM, filenames `ta-01.wav` … `hi-13.wav`
  (gitignored — audio stays local)

Ground-truth fields per entry: `file`, `sourceLang`, `domain`, `tags`,
`speaker`, `context`, `durationSec`, `spoken`, `spokenMeaning`,
`expectedTranslation`, `expectedTranslationMeaning`, `mustPreserve`, `notes`.

`spoken` and `expectedTranslation` are colloquial — that's the register the app
must produce. The `*Meaning` fields are standard-language references for human
review only; **never grade against them.**

---

## Slice 1 — Shell and capture

**Goal:** two halves, two buttons, audio blobs in memory. No AI yet.

> Scaffold a Next.js + TypeScript app. Single page, split vertically: top half
> Tamil (labelled in Tamil script), bottom half Hindi (labelled in Devanagari).
> Each half has a large hold-to-talk button — at least 44px tall, thumb-reachable,
> using `pointerdown`/`pointerup` so it behaves on touch. Recording uses
> MediaRecorder with `echoCancellation: true` and `noiseSuppression: true`,
> picking a supported mimeType at runtime since Android Chrome and iOS Safari
> disagree. On release, store the blob in a React session array as
> `{ id, side: 'ta' | 'hi', blob, timestamp }` and render the blob size on screen
> so I can confirm capture worked. No API calls. Handle mic permission denial
> with a clear message in Tamil, Hindi, and English.

**Done when:** you hold each button on a real phone and see a non-zero byte
count. If you see 0 bytes, it's the mimeType.

---

## Slice 2 — The translate endpoint

**Goal:** a proven core, testable without any UI.

> Add `POST /api/translate`. It accepts an audio blob plus a `sourceLang` field
> of `ta` or `hi`. Base64-encode the audio and send one call to OpenRouter
> `/api/v1/chat/completions` using the `input_audio` content type, with a model
> from `lib/models.ts`. The system prompt must transcribe in the given source
> language and translate to the other, and must follow locked decision 5 in
> CLAUDE.md on register — natural spoken form, keep shared English loanwords,
> no literary substitution. Return only JSON: `{ original, translation }`.
> Strip markdown fences, validate the shape, retry once on malformed output,
> then return a structured error. Key stays server-side.

Then the eval harness:

> Add `npm run eval`. It reads `test-clips/ground-truth.json`, posts each `.wav`
> to `/api/translate` with the entry's `sourceLang`, and prints a table:
> file, sourceLang, domain, elapsed ms, transcribed original, translation,
> and a PASS/FAIL on `mustPreserve`.
>
> `mustPreserve` check: normalise both the output and the expected token before
> comparing — spoken number words to digits in both scripts
> (எட்டாயிரம්/आठ हज़ार → 8000, ரெண்டு/दो → 2, அஞ்சு/पांच → 5), and day names to
> a canonical English form. A mustPreserve token counts as present if it appears
> in either digit or word form.
>
> Print summary rows at the end: mean and p90 latency, mustPreserve pass rate,
> and both broken down by `domain` so I can see if general-domain clips are
> worse than tailoring ones. Support `npm run eval -- --domain=general` and
> `-- --model=<id>` for A/B runs.

**Done when:** all 26 clips return sane translations and mustPreserve passes.
Judge register by reading the output against `expectedTranslation`, not
`expectedTranslationMeaning`.

Clips worth watching specifically: **hi-12** ("एक पांच घंटे" — the एक is a hedge
meaning "about", not the number 1; models produce 15 or 1), **hi-08**
(either-or structure often collapses to one option), **ta-13** and **hi-13**
(money — the highest-stakes failures), **ta-11 / ta-12 / hi-11** (one- and
two-word turns).

---

## Slice 3 — Wire it up

> Connect each half's button to `/api/translate` with the correct `sourceLang`.
> Show the original on the speaker's side and the translation on the listener's
> side, in that side's script, at large readable size. Add per-side loading and
> error states. Translation is re-tappable to replay. Keep the raw blob in
> session memory alongside the result.

> **Capture rewrite (required here):** OpenRouter `input_audio` rejects the
> `webm/opus` that Slice 1's `MediaRecorder` produces on Android Chrome. Replace
> live capture with a client-side AudioWorklet that encodes 16kHz mono PCM16 WAV
> — matching the `test-clips/*.wav` format — and send `format: "wav"`. Keep
> `echoCancellation`/`noiseSuppression` on the `getUserMedia` track (upstream of
> the worklet). Do NOT use server-side ffmpeg. See CLAUDE.md → Stack.

**Done when:** two people can hold a conversation by tapping. This is already
usable — try it in a real shop before moving on.

---

## Slice 4 — Voice output

> Add TTS via OpenRouter `/api/v1/audio/speech` behind `POST /api/speak`.
> Autoplay the translation on the listener's side. **Before playback starts,
> hard-mute the mic stream; unmute 250ms after the `ended` event.** Add a replay
> button. If TTS fails, the text stays on screen — never block on audio.

**Done when:** audio plays and mic mute/unmute is verifiable in the console.
Benchmark Tamil and Hindi voice quality across available TTS models — Tamil is
usually the weaker one.

---

## Slice 5 — Hands-free toggle

**The risky slice.** Everything before this is your fallback.

> Add a hands-free toggle. When on: continuous mic with VAD-based turn
> segmentation, mic hard-gated during TTS playback, and language routing that
> falls back to whichever side was last tapped when detection is low-confidence.
> Add a semantic guard — if a new transcription is >90% similar to the last
> thing we spoke, drop it silently. Tap-to-talk stays available and takes
> priority. Log every segment decision so I can debug why a turn fired or didn't.

**Done when:** it survives 10 minutes in a noisy room without a runaway loop.
Tune VAD against recordings from the actual environment. If it can't be made
reliable, ship slices 1–4 and say so.

---

## Slice 6 — Speaker attribution

> Add speaker enrollment. During normal tap-to-talk use, build a voice embedding
> per side from the stored session audio. In hands-free mode, use speaker
> identity to route language (voice A = Hindi, voice B = Tamil) instead of
> detecting language from content, and to ignore segments matching neither
> enrolled speaker.

This is what makes the boutique case work — it stops bystanders and the TV from
being translated mid-negotiation, and makes one-word turns unambiguous.
Enrollment falls out of slices 1–4 for free. The `speaker` field in
ground-truth.json exists to test cross-voice routing here.

---

## Open items

- **`expectedTranslation` fields need native-speaker verification.** They were
  drafted by an LLM. Until a Tamil and a Hindi speaker sign off, treat eval
  register judgements as provisional.
- Missing clip types: proper names (people, places), and clips with heavy
  background noise. Add when convenient — not blocking.

## Session hygiene

- One slice per session. Long sessions drift.
- Commit working code before starting the next slice.
- When you correct Claude Code on something that will recur, put it in
  `CLAUDE.md` rather than repeating it next session.
- Keep `CLAUDE.md` short. Past ~100 lines, move detail into `.claude/rules/`.
