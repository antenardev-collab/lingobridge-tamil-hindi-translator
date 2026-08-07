# Tamil ↔ Hindi Voice Translator

## What this is

A two-way speech translation web app for conversations between Hindi-speaking
migrant workers and Tamil speakers in Tamil Nadu — shops, boutiques, sites,
markets. The end goal is a hands-free mode where the phone sits on a counter
and translates a conversation without anyone touching it.

We are building toward that in stages. **Do not jump ahead to hands-free.**
See `docs/PLAN.md` for the slice order and what is currently in scope.

## Stack

- Next.js (App Router) + TypeScript, deployed on Vercel
- All AI calls go through OpenRouter — one API key, server-side only
- **STT + language detection + translation: a single call** to
  `/api/v1/chat/completions` with the `input_audio` content type.
  Do not split this into separate transcribe → detect → translate steps.
- **TTS:** OpenRouter `/api/v1/audio/speech`
- No database. Session state lives in React memory only.

## Locked architecture decisions

These were decided deliberately. If you think one is wrong, say so and stop —
do not silently work around it.

1. **Speaker-selected language, not auto-detection.** Split screen: Tamil half,
   Hindi half. Each person taps their own side to speak. The tap tells us the
   source language, so we never guess. This eliminates misdetection on short
   utterances ("haan", "seri", "ok", numbers, names) and on code-mixed speech,
   which is constant in this population.

2. **Echo loop is solved by muting the mic, not by classifying audio.** We
   control TTS playback, so we know when the machine is speaking. Hard-gate the
   mic on `play()`, unmute on `ended` plus a 250ms reverb tail. Never try to
   detect "is this the machine talking" from the audio itself.

3. **Latency beats model quality.** A 5-second pause kills a real conversation.
   Prefer fast mid-tier multimodal models (Gemini Flash class) over frontier
   models. Target under 2s from release-to-speak.

4. **Retain raw audio per turn in session memory** from slice 1 onward, keyed by
   which side was tapped. Slice 6 uses it for speaker enrollment. It is not used
   before then — keep it, don't wire it up.

## Hard rules

- `OPENROUTER_API_KEY` is server-side only. It must never appear in client
  bundles, `NEXT_PUBLIC_*` vars, or a browser `fetch`. All model calls go
  through Next.js route handlers.
- API routes return validated, typed JSON — never raw model output. Models
  wrap JSON in markdown fences; strip and parse defensively, and fail loudly.
- All model IDs live in `lib/models.ts`. Never hardcode a model string
  elsewhere. Verify IDs against openrouter.ai/models before using them —
  they change.
- Mobile-first. Design and test at 390px width. Assume 4G on a noisy site,
  not office wifi.
- Every user-facing string must exist in Tamil, Hindi, and English.
  No English-only UI text.

## Commands

```bash
npm run dev        # local dev
npm run build      # must pass before any commit
npm run lint
npm run eval       # runs recorded test clips through /api/translate (slice 3+)
```

## Testing constraints

Microphone access requires HTTPS. Localhost will not give you working mic
capture on a physical phone — test on Vercel preview URLs on a real Android
device. Every PR gets one.

## Out of scope

Auth, conversation history, offline mode, any language other than Tamil and
Hindi, native app packaging, payments.
