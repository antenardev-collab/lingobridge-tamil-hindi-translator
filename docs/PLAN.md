# Build Plan

Six slices. Each is roughly one Claude Code session and ends with something you
can open on a phone and judge. Commit after every green slice. Use plan mode
(Shift+Tab twice) before starting each one — read the proposed approach and
correct it before any code exists.

Do not start a slice until the previous one works on a real device.

## Assets already in place

- `test-clips/ground-truth.json` — 26 entries, 13 Tamil source + 13 Hindi source
- `test-clips/*.wav` — 16kHz mono 16-bit PCM, filenames `ta-01.wav` … `hi-13.wav`
  (gitignored — audio stays local). These are ffmpeg output: a **78-byte header**
  carrying a `LIST/INFO` `ISFT: Lavf63.1.100` chunk between `fmt ` and `data`, not
  a canonical 44-byte header. That chunk is inert metadata the model ignores; the
  load-bearing property is the PCM stream (16kHz / mono / 16-bit LE).

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

## Slice 2 — The translate endpoint ✅ COMPLETE (2026-08)

`/api/translate` (pipeline-agnostic) + `npm run eval` / `npm run eval:tts` shipped.
`gemini-direct` locked as the translation pipeline, native-speaker validated both
directions. See CLAUDE.md → Stack for the A/B and TTS findings.

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

**Pipeline-agnostic:** `/api/translate` runs behind a `pipeline` selector so we
A/B two providers on real clips rather than guess. Pipeline A `openrouter-single`
(`openai/gpt-audio-mini`) vs Pipeline B `gemini-direct` (`gemini-2.5-flash-lite`).
Both return the identical validated shape. Eval takes `--pipeline=` alongside
`--model=`, and records per-clip token usage + cost so we compare quality per
rupee, not just latency. See CLAUDE.md → Stack.

**Done when:** all 26 clips return sane translations and mustPreserve passes.
Judge register by reading the output against `expectedTranslation`, not
`expectedTranslationMeaning`.

Clips worth watching specifically: **hi-12** ("एक पांच घंटे" — the एक is a hedge
meaning "about", not the number 1; models produce 15 or 1), **hi-08**
(either-or structure often collapses to one option), **ta-13** and **hi-13**
(money — the highest-stakes failures), **ta-11 / ta-12 / hi-11** (one- and
two-word turns).

---

## Slice 3 — Live capture to the endpoint ✅ COMPLETE (2026-08-11)

**Delivered:** AudioWorklet capture emitting 16kHz mono PCM16 WAV (canonical
44-byte header), encoder byte-identical to ground-truth PCM on a decode→encode
round-trip and verified on-device at **15925–16364 Hz** across live turns; a
persistent `CaptureEngine` keeping the mic/context/graph warm across turns,
eliminating the ~200 ms idle-wake front-of-clip loss; an ownership-token fix so a
simultaneous hold on both halves can't send one speaker's audio under the other's
`sourceLang`; and each half wired to `/api/translate` with per-side parallel state
(never blocking capture, no cancellation) and a 400 / 502 / network error taxonomy
that surfaces the route's own `error`+`detail`. On-screen text stays a debug aid
only (decision 6); raw WAV retained per turn in session memory (decision 4).

**Carried into Slice 4** (recorded in the findings below): the deterministic
`ஐயாயிரம்` → `ஐயா` utterance-initial mishearing (a model lexical-prior quality
issue, not capture); STT-stage romanisation as a problem *distinct* from
TTS-stage romanisation (pre-TTS transliteration won't fix the transcription
`original`); and the sub-2s latency gap, which makes measuring translate TTFT the
first Slice 4 task.

**The real work was the capture rewrite.** OpenRouter `input_audio` and Gemini
inline audio both reject the `webm/opus` that Slice 1's `MediaRecorder` produces
on Android Chrome.

> Replace live capture with a client-side AudioWorklet that encodes 16kHz mono
> PCM16 WAV — matching the `test-clips/*.wav` format — and send `format: "wav"`.
> Keep `echoCancellation`/`noiseSuppression` on the `getUserMedia` track
> (upstream of the worklet). Do NOT use server-side ffmpeg. See CLAUDE.md → Stack.

> Then wire each half's button to `/api/translate` with the correct
> `sourceLang`. Add per-side loading and error states, and keep the raw blob in
> session memory alongside the result (locked decision 4). On-screen
> original/translation is a debug aid only (locked decision 6) — render it
> minimally; do not invest in per-script typography or sizing. Spoken playback is
> Slice 4.

> **Format parity is load-bearing — but it is PCM-stream parity, not whole-file
> byte-identity.** The AudioWorklet must emit the same *PCM stream* the eval clips
> carry (16kHz mono 16-bit LE). It emits a **canonical 44-byte header by design**
> and does NOT reproduce the clips' 78-byte ffmpeg `LIST/INFO` chunk — asserting a
> `Lavf` provenance on live-captured audio would be false, and the model ignores
> the chunk regardless. What would break the Slice 2 baseline is a divergent PCM
> stream (wrong rate, channel count, or sample encoding), not a different-but-valid
> container header. **Fallback if the worklet can't emit 16kHz cleanly: downsample
> server-side in `/api/translate` to 16k mono PCM16 before the model call. Do NOT
> re-encode `test-clips/*.wav`** — they are ground truth; altering them invalidates
> the baseline permanently.

### Slice 3 findings (2026-08-10 – 08-11)

- **Device honours `sampleRate: 16000`.** Verified on the real Android phone
  (Chrome 150): a requested 16k `AudioContext` reports 16000 (default is 48000,
  so it's honoured, not coincidence) and the `MediaStreamAudioSourceNode` sits in
  the 16k context — Chrome resamples at the graph boundary. So the worklet needs
  only Float32→Int16 + framing + a 16kHz WAV header: **no manual decimator, no
  low-pass filter.** The track's own `sampleRate: 48000` is the hardware capture
  rate and is expected. **The server-side downsample fallback above stays
  recorded and unused — do not build it.**
- **Clips have a 78-byte header (ffmpeg `LIST/INFO`), not 44 — the worklet emits
  canonical 44 by design.** Found while building the encoder: `fmt ` →
  `LIST/INFO ISFT: Lavf63.1.100` → `data`. The encoder lives in `lib/wav.ts`
  (shared and importable, so it is testable); the worklet (`public/worklets/
  pcm-recorder.js`) does framing only and posts Float32 frames, and the main
  thread does Float32→Int16 + header. Off-device round-trip (decode a clip with
  `decodeAudioData` in a 16k context → `floatToInt16`/`encodeWav` → diff the PCM
  region) is **byte-identical**: 0 diffs over 30037 samples, `−32768`/`+32767`
  edges correct, header fields canonical. Worklet plumbing (static-asset load +
  `process()` pull) verified via an OfflineAudioContext render, and **confirmed
  on-device** (13 turns): well-warmed turns read 15974–16018 Hz on the implied-rate
  readout, flat from 0.5s to 5.5s — no rate drift, encoder validated on hardware.
- **`DEFAULT_PIPELINE` was `openrouter-single` — the rejected pipeline — while
  CLAUDE.md locks `gemini-direct`.** A code default disagreeing with a locked
  decision. Corrected to `gemini-direct` so the Slice 3 client can omit `pipeline`
  and inherit the right one (one source of truth). `scripts/eval.mjs` used to
  carry its *own* hardcoded default and would have re-baselined against the
  rejected pipeline on a bare `npm run eval`; it now imports `DEFAULT_PIPELINE`
  from `lib/models.ts`, so endpoint and eval share the single default. The eval
  prints `pipeline=…` in its header, `meta.pipeline` in the JSON, and the pipeline
  in the results filename, so every run's provenance is in its own output.
- **`/api/translate` now rejects non-WAV bytes** with a RIFF/WAVE magic-number
  check (400), so a worklet format regression fails loud at the endpoint instead
  of as an opaque Gemini error. All 26 clips still pass (26/26 header + live eval).
- **Idle-wake front-of-clip loss — fixed by warming the capture graph.** On-device,
  turns after a long idle gap lost ~177–223 ms of *leading speech* — a fixed cost
  that correlated 13/13 with idle time (≈0 under ~12s idle, ~200 ms over ~17s),
  independent of turn length. Cause: per-turn acquisition — the graph woke on
  pointerdown and the first frames arrived ~200 ms after the user, who acts on the
  OS touch-down haptic, had already started speaking. Fix: `CaptureEngine` keeps one
  `MediaStream` + `AudioContext` + worklet graph **warm across turns** (acquired
  lazily on first interaction, not page load; frames pulled continuously and dropped
  when not recording so idle frames can't accumulate; re-acquired via `ensureWarm`
  if the OS suspends/revokes on backgrounding — never capturing silence). The mic is
  live before the tap, so the OS haptic is honest. Consequence: the mic indicator now
  stays lit for the whole session (intended — decision 2 gates it during playback in
  Slice 4). The visual recording state is gated on the **first real `process()`
  frame** (not on warm-up resolving): instant when warm, a visible lag if warming
  ever regresses — a permanent free detector for this bug.
  - **The haptic is NOT ours.** There is no `navigator.vibrate` in the app; the
    touch-down buzz is Android system feedback we can neither move nor suppress.
    Warming is the only lever that makes it honest — hence not "delay the buzz."
  - **For the eventual native rebuild (not POC work):** the ~200 ms idle-wake cost
    may be Android audio-HAL-level (cold input path), not Chrome-level. **Not
    investigated.** If so, a native app inherits it and needs the same always-warm-
    input strategy — recorded so it isn't rediscovered from scratch.
- **First translate-leg latency off localhost (on-device, mobile network).**
  Complete-time (not TTFT) for the `/api/translate` call. First run, 8 turns: 1562,
  1675, 2289, 3201, 3347, 3604, 4028, 4275 ms — **median ~3.3s, only 2/8 under 2s.**
  A second, shorter-turn run: **1759 / 1769 / 2033 ms.** Against the sub-2s
  release-to-speak target (decision 3) this is a serious gap. It makes
  **measuring translate TTFT the first task of Slice 4** (see the Slice 4 TTFA notes
  below): the ~3.3s is a complete-time upper bound, not a measured floor, so the
  overlap-vs-Live-API decision needs the real time-to-first-token first. Recorded,
  not acted on.
- **RESOLVED — Tamil utterance-initial `ஐயாயிரம்` (5000) is misheard as `ஐயா`, not
  dropped.** Both device failures opened with `ஐயா` (`ஐயா, இதோ` and `ஐயா, இதுல ஒரு
  பீஸ்`). Settled with the retained WAV (decision 4) via the temporary download
  affordance; both earlier hypotheses are dead: (1) **capture exonerated** — all four
  waveforms show clean silence-then-onset, nothing starts at sample zero; (2) **not a
  context-free-numeral limit** — a bare utterance-initial `5000` transcribed correctly.
  The real cause is a **lexical prior**: utterance-initially both `ஐயாயிரம்` (5000) and
  `ஐயா` (a common address form) fit, and the more frequent word wins; mid-utterance
  `ஐயா` doesn't fit the syntax, so the number survives (`இந்த dress-க்கு 5000 bill போடு`
  keeps it). **Deterministic**, not sampling variance: the failing clip run 5× through
  `gemini-direct` returned `ஐயா, இதோ பில் போடுங்க.` identically all five times. The clip
  is kept local as `test-clips/probe-initial-number.wav` (gitignored, deliberately
  outside the numbered set); **not** added to `ground-truth.json` — a 27th entry would
  silently shift the 26-clip Slice 2 baseline. Whether to build a curated
  utterance-initial-number clip set is deferred until after this result. No fix, no
  prompt change this slice.

**Done when:** holding a button on a real Android phone captures WAV, posts to
`/api/translate`, and returns a correct translation — verified on a Vercel
preview URL. Full spoken back-and-forth waits on Slice 4 (voice output).

---

## Slice 4 — Voice output

> Add TTS via OpenRouter `/api/v1/audio/speech` behind `POST /api/speak`.
> Autoplay the translation on the listener's side. **Before playback starts,
> hard-mute the mic stream; unmute 250ms after the `ended` event.** Add a replay
> button. If TTS fails, the text stays on screen — never block on audio.

> **Superseded — TTS provider.** The blockquote above (OpenRouter
> `/api/v1/audio/speech`) predates the Slice 2 TTS findings. CLAUDE.md → Stack now
> locks **Gemini native TTS** (`generateContent`, `responseModalities:["AUDIO"]`)
> for both languages. Build 4c against CLAUDE.md, not this blockquote.

### Slice 4 sub-slices

- **4a — instrumentation & decomposition (SCOPE ADDITION, not "voice output").**
  This is *not* TTS. It was added because the sub-2s release-to-speak target
  (decision 3) can't be decided against the ~3.3s **complete-time** measured in
  Slice 3 — that figure is transport + model waiting, undecomposed, and the two
  halves have completely different fixes. 4a instruments release→encoded→
  firstByte→complete on the client and entry→geminiRequestSent→geminiComplete→exit
  on the server (returned additively under a `debug` key), derives transport as a
  same-clock subtraction `(client encoded→complete) − (server entry→exit)` (never
  a cross-clock diff — the clocks aren't synchronised), and surfaces per-turn plus
  a copy-as-JSON export. **Gate: the latency target is decided here, with numbers.**
  - **Streaming answer, corrected after a live probe (2026-08-14).** An initial
    WebFetch-summarized read of Google's API reference claimed audio-input
    streaming was documented; that summary was wrong (it flattened separate
    per-method example tabs) and the user caught it against the docs directly.
    A real 3-run `streamGenerateContent?alt=sse` probe (scratchpad, `ta-08.wav`,
    production prompt + `responseMimeType`) found it **does** call successfully
    and **does** return genuinely incremental SSE chunks (5 distinct frames/run,
    each a different text slice, output byte-identical to the non-streaming
    baseline) — but **firstChunk lands within ~2ms of complete in every run**
    (1620/3385/3686ms vs 1622/3387/3688ms). Confirmed not a JSON-mode artifact
    (same burst with `responseMimeType` removed entirely). **No usable TTFT here.**
    Decision: **not** switching `/api/translate` to consume SSE. 4a ships with
    `requestToFirstByteMs: null`, `weStream: false`.
    - **Risk marker (independent of the latency finding):** `GET
      /v1beta/models/gemini-3.1-flash-lite` lists `supportedGenerationMethods` as
      `["generateContent", "countTokens", "createCachedContent",
      "batchGenerateContent"]` — **`streamGenerateContent` is not on that list**,
      despite working. It's an unlisted/undocumented capability path for this
      model, not a first-class supported method per the model's own metadata.
      Another reason not to build production behavior on it.
    - `modelStatus.modelStage` / `retirementTime`: absent from every surface
      checked (`generateContent`, `streamGenerateContent` SSE frames, and
      `models.get`). The preview-dependency question from the Slice 2 findings
      (CLAUDE.md → Stack) remains open — not answered by data, not answerable
      from this API.
  - **Thinking-level hypothesis — tested and DEAD (2026-08-14).** The streaming
    probe's ~2× spread on identical input raised "is Flash-Lite's default
    'thinking' eating the wall-clock time before any output token?" as a
    candidate cause. Google's docs (`generate-content/gemini-3`, Thinking Level
    table, reproduced verbatim) give `gemini-3.1-flash-lite` a **default
    `thinkingLevel` of `minimal`** (not dynamic); all four levels — `minimal`,
    `low`, `medium`, `high` — are accepted. Tested directly: production
    non-streaming `generateContent` shape, `ta-08.wav`, 5 configs (current/no
    `thinkingConfig`, then each level lowest→highest) × 5 runs = 25 calls.
    **`usageMetadata.thoughtsTokenCount` is absent from the response schema at
    every level, including `high`** (confirmed via a raw dump, not just a `??0`
    default) — the model reports zero thinking tokens regardless of configured
    depth for this call shape. Latency showed no monotonic trend against level
    (medians 1569–2274ms, overlapping; `high` was fastest median, backwards from
    what a thinking-cost theory predicts). `original`/`translation` were
    character-identical across all 25 runs. **Not a latency lever. Do not
    revisit without new evidence** — this was the direct measurement the
    hypothesis asked for, not an inference from noisy timing.
  - **Reference point: direct desktop→Gemini vs. on-device→IAD1→Gemini.** The
    thinking-level probe's 25 direct-from-Chennai desktop calls (bypassing our
    Vercel function and mobile transport entirely) had `requestToCompleteMs`
    median **~1.6–2.3s**. Slice 3's on-device mobile measurement (via IAD1) had
    complete-time median **~3.3s**. The gap between those two medians is the
    transport/platform envelope (mobile network + IAD1 hop + function overhead)
    that the region probe (below) and the on-device 4a session are meant to
    separate out — desktop-direct is a lower bound, not what a user experiences.
  - **Tail latency is real and unexplained.** 1 run in 25 (thinking-level probe,
    `medium` config) hit 10,150ms; the other 24 in the same batch were
    1.3–3.5s. Not config-specific — inconsistent with any of the levers tested
    so far. **The eventual latency target needs a p90/p99 and a timeout/retry
    policy, not just a median** — a single mean or median hides this.
- **4b — harden the transliterator**, promote it into `lib/` as a pure,
  unit-testable, no-network module — *before* the TTS route, so 4c is built around
  it. (Already exercised on ~6 clips; threw one 400 on an intra-word hyphen.)
- **4c — TTS route** (`/api/speak`): Gemini native TTS, streaming, playback on the
  first chunk, per-side fixed voice, mic hard-gate on `play()` + unmute on `ended`
  + 250ms (decision 2). Do **not** pipeline translate→TTS this slice (measured TTFA
  ~1.3s, flat across input length; chunking risks prosody breaks and mid-numeral
  flushes).
- **4d — on-device release-to-first-audio test**, end to end.

**Done when:** audio plays and mic mute/unmute is verifiable in the console.
Benchmark Tamil and Hindi voice quality across available TTS models — Tamil is
usually the weaker one.

### TTS latency & model notes (from Slice 2 eval probes, 2026-08)

- **Streaming TTFA is the metric — and there is no 2.5 baseline.**
  `gemini-3.1-flash-tts-preview` supports `stream: true` (`:streamGenerateContent`);
  `gemini-2.5-flash-preview-tts` does not. Measured streaming time-to-first-audio
  on 3.1 is **~1.3s median, flat across input length** (n=3/clip). The earlier
  non-streaming figures (2.5–7.6s) were **n=1 and unreliable — do not quote them**;
  and since 2.5 can't stream, **there is no trustworthy 2.5 latency baseline**, so
  none should be cited. The translate leg's ~1.7s is a **complete time, not
  time-to-first-token**, so the ~3.0s sequential figure is an **upper bound, not a
  measured floor**. **First task of Slice 4: measure translate TTFT** (the
  `stream-ttfa` probe can be repointed at `generateContent` streaming), *before*
  choosing between overlapping the two calls and the Live API.
- **Transliterate before TTS.** Latin script degrades TTS pronunciation (both
  directions, both forms). Add a deterministic target-script transliteration step
  in `/api/speak` before synthesis — this is where the held "romanisation" work
  belongs, not in the translation prompt. Preserves decision 5 (loanword survives,
  only script changes). See CLAUDE.md → TTS.
  - **Romanisation appears one stage earlier than we'd been treating it — in the STT
    transcription, not just translation/TTS.** On-device (2026-08-11), one turn's
    `original` came back as `5000 bill podunga` — romanised Tamil in the transcription
    `original`, before any translation or TTS step. So a pre-TTS transliteration step
    fixes the *spoken* path but not the `original` itself; the drift originates in the
    model's transcription. Intermittent (the `probe-initial-number` clip's 5 runs were
    all in Tamil script), consistent with the ~19%-romanised Slice 2 eval finding.
    Recorded, not acted on.
  - *Dead end recorded (no commit to find):* a prompt-level rule forcing
    whole-sentence target-script output was tried **in the working tree** during
    Slice 2. It only partially worked (some clips moved to target script, others
    did not) and was **discarded without ever being committed** — so there is no
    revert commit and nothing to `git log`. It was dropped because `gemini-direct`
    was validated by native speakers against the *current* prompt, and changing
    the prompt invalidates that validation. The fix moves to deterministic
    pre-TTS transliteration in Slice 4 (see the bullet above); the prompt rule may
    be revisited later as a *complement*, not a replacement. Do not re-try it blind.
- **Speech-to-speech (Live API) is reachable but not a drop-in.** Our key can
  reach `gemini-3.1-flash-live-preview` (method `bidiGenerateContent`, a
  bidirectional WebSocket). It collapses translate+speak into one round trip, but
  it is designed for **continuous full-duplex audio**, which conflicts with
  **locked decision 2** (hard mic-gate during TTS playback: we mute on `play()`,
  unmute after `ended`). Treat the Live API as a separate architecture with that
  constraint to solve, not a swap into the current tap-to-talk design. Per-model
  Tamil/Hindi support is also not documented — must be tested before relying on it.
- **Preview-model dependency is a post-POC risk, not a Slice 4 blocker.**
  `gemini-2.5-flash-preview-tts` has **no announced shutdown date** — the
  2026-10-16 date on Google's deprecations page is for the *text* models
  (`gemini-2.5-flash` / `gemini-2.5-pro`), which we do not use. Google lists
  `gemini-3.1-flash-tts-preview` as the recommended replacement for 2.5 TTS. Both
  speaking-path models are **preview** with no shutdown date; plan to revisit once
  a GA TTS model ships.

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
