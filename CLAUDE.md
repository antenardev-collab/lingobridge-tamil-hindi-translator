# Tamil ↔ Hindi Voice Translator

## What this is

A two-way speech translation web app for conversations between Hindi-speaking
migrant workers and Tamil speakers in Tamil Nadu. First test site is a boutique
/ tailoring shop, but the app must work for ordinary conversation too — do not
build tailoring-specific logic into the app.

The end goal is a hands-free mode where the phone sits on a counter and
translates without anyone touching it. We build toward that in stages.
**Do not jump ahead to hands-free.** See `docs/PLAN.md` for the slice order.

## Stack

- Next.js (App Router) + TypeScript, deployed on Vercel
- All AI calls go through OpenRouter — one API key, server-side only
- **STT + translation: a single call** to `/api/v1/chat/completions` with the
  `input_audio` content type. Do not split into transcribe → translate steps.
  - **`input_audio` does NOT accept webm/opus.** Accepted formats: `wav, mp3,
    aiff, aac, ogg, flac, m4a, pcm16, pcm24` — standardize on `wav`. Android
    Chrome's `MediaRecorder` produces `webm/opus`, so live capture must be
    rewritten to client-side AudioWorklet WAV encoding (16kHz mono PCM16) in
    Slice 3. **Not** server-side ffmpeg — no server audio dep, no extra latency.
    The `test-clips/*.wav` are already WAV, so the Slice 2 eval needs no change.
- **TTS:** OpenRouter `/api/v1/audio/speech`. Use Google Gemini Flash TTS —
  it covers both Tamil and Hindi; OpenAI/Mistral TTS Indian-language support is
  weaker.
- No database. Session state lives in React memory only.

## Locked architecture decisions

Decided deliberately. If you think one is wrong, say so and stop — do not
silently work around it.

1. **Speaker-selected language, not auto-detection.** Split screen: Tamil half,
   Hindi half. Each person taps their own side to speak. The tap tells us the
   source language, so we never guess. This eliminates misdetection on short
   utterances ("சரி", "haan", numbers, names) and on code-mixed speech, which is
   constant in this population.

2. **Echo loop is solved by muting the mic, not by classifying audio.** We
   control TTS playback, so we know when the machine is speaking. Hard-gate the
   mic on `play()`, unmute on `ended` plus a 250ms reverb tail. Never try to
   detect "is this the machine talking" from the audio itself.

3. **Latency beats model quality.** A 5-second pause kills a real conversation.
   Prefer fast mid-tier multimodal models (Gemini Flash class) over frontier
   models. Target under 2s from release-to-speak.

4. **Retain raw audio per turn in session memory** from slice 1 onward, keyed by
   which side was tapped. Slice 6 uses it for speaker enrollment. Keep it,
   don't wire it up.

5. **Colloquial register in, colloquial register out.** Real speech here is
   heavily code-mixed: "இந்த வொர்க் முடிக்க எவ்ளோ டைம் ஆகும்?",
   "मैम, नाइट वर्क करना मुश्किल है". The translation prompt must explicitly
   instruct the model to output natural spoken register and **keep the English
   loanwords both parties already share** — work, design, stone, delivery,
   customer, time. Do NOT substitute literary equivalents (வேலை, விநியோகி,
   पत्थर, विनियोग). Models drift toward formal register unprompted because it
   looks more "correct"; it is a failure here, because the listener won't
   understand it.

## Hard rules

- `OPENROUTER_API_KEY` is server-side only. Never in client bundles,
  `NEXT_PUBLIC_*` vars, or a browser `fetch`. All model calls go through
  Next.js route handlers.
- API routes return validated, typed JSON — never raw model output. Models wrap
  JSON in markdown fences; strip and parse defensively, and fail loudly.
- All model IDs live in `lib/models.ts`. Never hardcode a model string
  elsewhere. Verify IDs against openrouter.ai/models — they change.
- Mobile-first. Design and test at 390px width. Assume 4G on a noisy site.
- Every user-facing string must exist in Tamil, Hindi, and English.
- **`test-clips/*.wav` is gitignored.** The audio contains real people's voices
  and stays local. Only `test-clips/ground-truth.json` is committed.

## Commands

```bash
npm run dev        # local dev
npm run build      # must pass before any commit
npm run lint
npm run eval       # slice 2+ — see docs/PLAN.md
```

## Testing constraints

Microphone access requires HTTPS. Localhost will not give working mic capture on
a physical phone — test on Vercel preview URLs on a real Android device.

## Out of scope

Auth, conversation history, offline mode, any language other than Tamil and
Hindi, native app packaging, payments.
