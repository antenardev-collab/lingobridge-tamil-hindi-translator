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
- Model calls are server-side only, behind Next.js route handlers. Two
  providers, two keys: `OPENROUTER_API_KEY` and `GEMINI_API_KEY`.
- **STT + translation: a single call** with the audio sent inline. Do not split
  into transcribe → translate steps.
  - **`/api/translate` is pipeline-agnostic.** We A/B two providers empirically
    rather than guess; both return the identical validated `{ original,
    translation }`. Configs live in `lib/models.ts`, impls in `lib/translate/`.
    - **Pipeline A — `openrouter-single`:** one OpenRouter
      `/api/v1/chat/completions` call, `input_audio`, format `wav`. OpenRouter
      exposes **only** `openai/gpt-audio` and `openai/gpt-audio-mini` for chat
      audio input — **there is no Gemini audio input via OpenRouter.**
    - **Pipeline B — `gemini-direct`:** one Google Gemini `generateContent` call
      with inline `audio/wav`. Default `gemini-3.1-flash-lite` (cheapest/fastest
      audio-in Flash-Lite available to new keys; `gemini-2.5-flash-lite` is
      cheaper but Google 404s it for new users). `gemini-3.6-flash` is the
      quality ceiling, alternate only.
    - **A/B finding (2026-08): `gemini-direct` is LOCKED as the translation
      pipeline** — validated end-to-end by a native Hindi speaker (ta→hi) and a
      native Tamil speaker (hi→ta). `gpt-audio-mini` has poor Tamil STT — it
      hallucinates whole utterances (ta-02), splices English words inside Tamil
      words (ta-08), and emits English phrases (ta-05); its Hindi STT is fine.
      Gemini transcribes Tamil near-perfectly. The quality gap is downstream of
      transcription, not the translation step.
  - **Inline audio does NOT accept webm/opus.** OpenRouter `input_audio` accepts
    `wav, mp3, aiff, aac, ogg, flac, m4a, pcm16, pcm24`; Gemini accepts
    `wav, mp3, aiff, aac, ogg, flac` — standardize on `wav` for both. Android
    Chrome's `MediaRecorder` produces `webm/opus`, so live capture must be
    rewritten to client-side AudioWorklet WAV encoding (16kHz mono PCM16) in
    Slice 3. **Not** server-side ffmpeg — no server audio dep, no extra latency.
    The `test-clips/*.wav` are already WAV, so the Slice 2 eval needs no change.
- **TTS (Slice 4c): ElevenLabs streaming TTS is LOCKED** as the second leg —
  `POST /v1/text-to-speech/{voice_id}/stream`, model `eleven_flash_v2_5`,
  output format `mp3_44100_128`, `language_code` set explicitly per direction
  (`ta`/`hi`). Voices: Tamil `wLIQpmGi7jT7aiEmDsE3` (Janani), Hindi
  `35h4XgJYQYdHtGbOCg7x` (Rohit) — both `professional` category (Voice
  Library) and require a paid ElevenLabs plan for API access; account is on
  **Starter**. (Leg 1 — STT + translation — is unchanged: Gemini direct,
  `gemini-3.1-flash-lite`, `temperature: 0`.)
  - **Output format is MP3, not PCM (2026-08-20).** `pcm_24000` was the
    initial choice, made for a chunk-scheduled playback path. Measurement
    (`docs/PLAN.md` → Slice 4, "Client playback format") showed chunked
    playback could save at most 15–245ms server-side, while PCM runs roughly
    3×–12× the payload of MP3 on the phone-to-server leg — the leg
    measurement showed to be the dominant and noisiest cost. Fetch the
    complete response, then play; no chunk scheduling.
  - **`eleven_multilingual_v2` is ElevenLabs' own default in their sample
    code — it is NOT our model.** It is slower and twice the price. Any code
    that calls ElevenLabs must set `model_id` explicitly to
    `eleven_flash_v2_5`; never rely on the provider default.
  - **Gemini native TTS was evaluated and rejected.** Reasons: no stable
    (non-preview) TTS model on the Gemini Developer API; a documented defect
    where the model occasionally returns text tokens instead of audio tokens;
    and measured TTFA roughly six times slower than ElevenLabs.
  - **Latin script in TTS input degrades pronunciation** — in both directions
    and in both forms (full romanisation *and* individual loanwords).
    **Transliterate the loanword into the target script before TTS; it sounds
    materially better.** This preserves decision 5: the shared loanword
    survives, only its script changes ("work" → வொர்க்/वर्क, never வேலை/काम).
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

   **Note (2026-08-20, withdrawn):** a chunked-playback path (streamed PCM,
   scheduled via Web Audio) was considered — and rejected on measurement; see
   `docs/PLAN.md` → Slice 4, "Client playback format." Client playback
   fetches the complete audio response and plays it through an `<audio>`
   element, so `play()` and `ended` both exist exactly as this decision
   describes. **Decision 2 stands exactly as written** — the earlier caveat
   here no longer applies.

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

6. **Audio-only interface.** The product is spoken: the two parties talk and
   listen, they do not read the screen. On-screen text (transcription,
   translation) is a debugging aid only, never a feature — and it must not drive
   any design decision (layout, timing, per-script typography, sizing) in Slice 3
   or later. When in doubt, optimise the spoken path and let the text be minimal.

## Hard rules

- `OPENROUTER_API_KEY` and `GEMINI_API_KEY` are server-side only. Never in
  client bundles, `NEXT_PUBLIC_*` vars, or a browser `fetch`. All model calls go
  through Next.js route handlers.
- API routes return validated, typed JSON — never raw model output. Models wrap
  JSON in markdown fences; strip and parse defensively, and fail loudly.
- All model IDs live in `lib/models.ts`. Never hardcode a model string
  elsewhere. Verify IDs against openrouter.ai/models and ai.google.dev — they
  change.
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

## Deployment

- Repo: https://github.com/antenardev-collab/lingobridge-tamil-hindi-translator
- Production: https://lingobridge-tamil-hindi-translator.vercel.app
- Vercel Hobby plan, single function region (IAD1 as of 2026-08). See
  `docs/PLAN.md` → Slice 4 for the region-latency investigation.

## Testing constraints

Microphone access requires HTTPS. Localhost will not give working mic capture on
a physical phone — test on Vercel preview URLs on a real Android device.

## Out of scope

Auth, conversation history, offline mode, any language other than Tamil and
Hindi, native app packaging, payments.
