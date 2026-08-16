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

**Live capture and the eval baseline are not the same signal (2026-08-15,
noted here since it bears on how to read eval numbers — Slice 2 itself is
unchanged).** Live capture (`lib/recorder.ts`) requests `getUserMedia({
echoCancellation: true, noiseSuppression: true })`; `autoGainControl` is left
to the browser default. The 26 `test-clips/*.wav` are raw ffmpeg recordings
with none of that processing applied. This does **not** invalidate the
Pipeline A/B lock above — both pipelines were scored against the identical
unprocessed clips, so that comparison stayed apples-to-apples. But an eval
score is not a prediction of live on-device behaviour: any future
live-vs-eval discrepancy should consider capture-side signal processing as a
candidate cause before suspecting the model.

### Prompt edit: venue-assumption removal, eval reproducibility, and a rejected no-speech rule (2026-08-15/16)

**The eval harness is a deterministic instrument.** A control run — `lib/prompt.ts`
reverted to the committed baseline, same 26 clips, same dev server — reproduced
the stored 07-26 baseline **26/26 byte-identical**: every clip, both `original`
and `translation`, and every summary statistic. At `temperature: 0`, a single
26-clip run against a stored baseline is a real measurement, not a sample.
**Caveat:** this holds for this model version on this serving stack; Google can
change serving behind a stable model name, so a future diff against an old
baseline may be a serving change, not ours.

**Prompt perturbation is not semantic effect.** Removing the venue phrase alone
changed 14 of 26 clips; that deletion plus the no-speech rule together changed
only 9 — adding a rule *restored* five clips to the baseline. Greedy decoding
means any change to the prompt token sequence shifts the output path
corpus-wide, so diff size tracks perturbation, not meaning. **Consequence: the
harness is a regression detector at a fixed prompt, not a quality instrument
for prompt iteration.** Iterating on the prompt against this harness is a loop
— each fix reshuffles roughly half the corpus, while `mustPreserve` reads 7/7
throughout, because it counts digits and proper nouns and cannot see loanword
substitution or register drift. **Do not tune the prompt against eval diffs.**

**What the venue-phrase removal actually caused.** Five clips landed
character-identical under two *independent* perturbations (the deletion alone,
and the deletion plus the no-speech rule): `ta-01`, `ta-09`, `hi-01`, `hi-09`,
`hi-12` — convergence, not reshuffling, so genuinely caused by the venue
phrase, not perturbation noise. Notably: `hi-12` improved from a fully
romanised `5 hours aagum ma'am.` to clean Tamil script (romanised count 5→4
both times the phrase was removed); `hi-09` substituted `வேலை` for `work` —
the exact case the prompt itself names as forbidden (`"never வேலை for
'work'"`), a locked-decision-5 register drift that nonetheless still passes
the comprehension bar. `mustPreserve` 7/7, 0 errors, both runs. Clips landing
on a third variant that matched neither the baseline nor the combined-edit
text (`ta-05`, `ta-07`, `ta-13`, `hi-04`) are perturbation, not identifiable
effect.

**The no-speech rule — tested and rejected, not shipped.** Wording tried: *"if
the audio contains no speech at all, output empty strings for both fields
instead of guessing plausible content."* It passed the negative test: it did
not fire falsely on any of 26 real-speech clips, including the single-word
ones. But it never fired at all on the case it was written for: four
consecutive live no-speech turns (1.24s / 1.18s / 1.08s, one more in the same
run) all returned HTTP 200 with the character-identical fabricated sentence
`இந்த ஆர்டர் எப்ப வரும்?`. Models will not reliably self-report hearing
nothing. **Do not re-propose a prompt-level fix for fabrication.**

**Fabrication is prompt-independent.** Before the venue phrase was removed,
the model's invented sentence on no-speech audio was `இந்த டிசைன்ல வேற கலர்
இருக்கா?`; after, it was `இந்த ஆர்டர் எப்ப வரும்?`. Both are built from the
prompt's own loanword vocabulary. Removing the domain framing changed *what*
it invents, not *whether* it invents. **The only viable defence is not
sending non-speech audio to the model at all** — a client-side energy gate,
extending 4b.2 (above) from duration-only to content-aware.

**Outstanding debt — see Open items below:** the venue-phrase removal (now
committed) invalidates the Slice 2 native-speaker validation that locked
`gemini-direct`. A revalidation pass is owed before this prompt is trusted on
a real shop floor, at 4d at the latest.

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
  - **Worse tail sample recorded (2026-08-15).** A 27,277ms server-side turn
    (`serverTotalMs`) was observed on a one-word utterance from the local dev
    server — worse than the 10,150ms outlier above. Transport was 25–78ms, so
    this is effectively all time inside the Gemini call, not client/network
    overhead. Reinforces the need for a timeout/retry policy (already flagged
    above); **not acted on this session** — recorded so it isn't lost.
  - **Fourth and fifth tail samples — clustering, not scattering (2026-08-16).**
    A 10,203ms turn on localhost, transport 73ms (effectively all inside the
    Gemini call, same pattern as above), and a 9,079ms turn in the same
    session. On record now: 10,150ms / 27,277ms / 53,093ms / 10,203ms /
    9,079ms — five outliers across unrelated sessions, not one fluke.
    **4c needs a timeout-and-abandon policy as a design input, not an
    afterthought.**
  - **Three more tail outliers (2026-08-16), sub-50ms transport.** 14,970ms,
    7,813ms, 6,948ms, all local runs. On record now: 10,150ms / 27,277ms /
    53,093ms / 10,203ms / 9,079ms / 14,970ms / 7,813ms / 6,948ms — eight
    outliers across unrelated sessions and environments. The pattern is now
    consistent, not incidental.
  - **Ninth tail outlier: 10,319ms server-side turn on a one-word
    utterance (2026-08-16).** Same shape as the others — a short utterance,
    a long server-side wait. Nine outliers now, still no timeout policy.
  - **Phone round trips this session (2026-08-16), an observation for 4d —
    not a conclusion.** 1462–2679ms end to end, server 811–1041ms, transport
    458–1690ms — materially better than the ~3.3s median that set the
    Slice 4 sub-2s target (decision 3). Too small and too session-local to
    revise the target on; carried to 4d for a real sample.
  - **Unexplained: `impliedHz: 10112` on a 0.544s capture (2026-08-16).**
    Roughly a third of samples missing at the front of that turn — larger
    than the known ~200ms idle-wake loss (Slice 3 findings) and the turn
    wasn't flagged as a cold start. Not investigated this session; carried
    to 4d.
  - **`x-vercel-id` is NOT the execution region — cost us a wrong conclusion
    once, recording so it doesn't happen again.** A production sanity POST from
    Chennai read `vercelId: "bom1::…"` off the request header and was briefly
    taken as evidence the function itself was running in Mumbai (contradicting
    the assumed IAD1 region). Per Vercel's own docs, `x-vercel-id` **accumulates
    region hops as the request travels and is edge-appended before the function
    executes** — a request-side read is the nearest edge PoP to the caller
    (Mumbai, for a Chennai client), not where the function ran. The dashboard
    confirmed the function region is actually `iad1`. **Fix: use
    `process.env.VERCEL_REGION`** (Vercel's docs: "The ID of the Region where
    the app is running", runtime-only) **as the authoritative execution region.**
    `debug` now reports both: `execRegion` (from `VERCEL_REGION`, load-bearing)
    and `edgeTrace` (the raw `x-vercel-id` header, kept verbatim, reference only
    — never treat it as the execution region again).
  - **Region experiment CLOSED WITHOUT A FLIP — production stays IAD1
    (2026-08-14).** Once `execRegion` was trustworthy, two production cold-start
    samples of the real Vercel→Gemini leg (`requestToCompleteMs`) read **757ms
    and 1218ms** from IAD1 — well under the 1.6–2.3s median measured calling
    Gemini *directly* from Chennai (the thinking-level probe's 25 desktop runs,
    above). A BOM1 flip would shorten the client→function leg but there's no
    evidence it shortens — and real evidence it could lengthen — the
    function→Gemini leg, since Gemini's own infrastructure siting is unrelated
    to Vercel's region choice; IAD1 already beats direct-from-Chennai on the leg
    that would move. **The 12-request BOM1 baseline was not run.** Don't reopen
    this without new evidence that Gemini responds faster to calls originating
    near Mumbai specifically.
  - **Payload-buffering check — VERIFIED FLAT (2026-08-14).** 4a's transport
    derivation, `(client encoded→complete) − serverTotalMs`, is only valid if
    Vercel buffers the request body before invoking the function; if it invokes
    while the body streams in, upload time lands inside `serverTotalMs` and gets
    misattributed to the model leg on every turn. Tested directly against
    production: 3 payload sizes × 3 sequential POSTs (9/9 HTTP 200, real
    `debug` on every run) — `ta-11.wav` (60,152 B), `ta-08.wav` (173,476 B), and
    a synthetic 730,498 B WAV (concatenated ground-truth PCM under a canonical
    header; content irrelevant, only byte count varied) — a **12.1× size range**.
    `entryToRequestMs` **min/median/max: 1/3/6 → 1/2/2 → 5/6/9** — single-digit
    ms at every size, no scaling proportional to the 12× payload growth (a true
    streamed-invoke would show tens–hundreds of ms at 730KB, not single digits).
    **Verdict: FLAT. The transport subtraction is sound.** No fix needed; 4a's
    numbers can be trusted going into on-device data collection.
- **4b — move the transliterator into `lib/`, wrapped in deterministic
  guards. REWRITTEN 2026-08-15** — the text this replaced ("promote it into
  `lib/` as a pure, unit-testable, no-network module") presumed a
  deterministic mapping already existed and just needed moving. The 26-clip
  dump (below) showed there is no mapping to promote, and there can't be one:
  **5 of 8 triggered clips arrived with the ENTIRE sentence romanised** in an
  ad-hoc scheme (`Blue color cut piece mudinjiduchu, naaliku eduthutu
  vaanga`) — arbitrary Tamil/Hindi vocabulary spelled out phonetically in
  Latin letters, not a loanword sitting in otherwise-correct script. A lookup
  table maps known tokens to known outputs; it cannot invert an
  open-vocabulary phonetic respelling of a language it doesn't otherwise
  touch. **Rejected: a deterministic lookup-table transliterator — dead end,
  do not re-propose without a fundamentally different input shape than
  "whatever Gemini's translation happened to romanise."** The transliteration
  call stays generative (Gemini). What's pure and testable is the guard layer
  wrapped around it:
  - **`lib/transliterate.ts`** — ports `transliterate` / `otherScript` /
    `normalizeDigits` / the hyphen-strip from `scripts/eval-tts.mjs`
    behaviourally unchanged; `scripts/eval-tts.mjs` now imports from `lib/`
    instead of keeping its own copy (confirmed `npm run eval:tts` still runs).
    Regression check: re-ran the 26-clip dump through the new module —
    **0 unexplained diffs**; the one difference from the original dump is a
    `script-purity` guard trip (see below), which changes nothing about the
    output, only logs it.
  - **Guard 1 — digit preservation (hard).** Ordered digit-run mismatch
    between input and the fully post-processed output → fallback.
  - **Guard 2 — non-empty/non-degenerate (hard).** Empty/whitespace output →
    fallback. (The 4b inventory found `.trim()` could silently yield `""`
    with nothing checking it — this closes that gap.)
  - **Guard 3 — script purity (warning only, never a rejection).** Residual
    Latin after transliteration is logged, not fixed or rejected — a
    mispronounced word stays comprehensible; rejecting the utterance doesn't.
    Fired once in the 26-clip regression run: `ta-09`'s `3D` (an alphanumeric
    designator, not a loanword) survives by design, logged, output unchanged.
  - **Hyphen strip — kept as-is, NOT a guard.** It's a Gemini TTS API 400
    workaround (an intra-word hyphen like `வொர்க்-கு` makes TTS reject the
    text with "tried to generate text ... should only be used for TTS"), not
    a quality check. Do not refactor it away as redundant with the prompt
    asking the model not to do this — it does it anyway often enough (2/8
    triggered clips in the dump) to stay load-bearing.
  - On a hard trip (guard 1 or 2), **or a network/API failure**: fall back to
    the **untransliterated input text**, unchanged, and let TTS handle it
    as-is — failing the turn outright is worse. But a network failure is a
    **different category from a guard trip, kept structurally separate**
    (2026-08-15 correction): a guard trip means the model answered and a
    guard rejected the answer; a failure means the stage never ran at all.
    That distinction matters because 5/8 triggered clips in the dump were
    FULLY romanised sentences — a skip on one of those means TTS reads e.g.
    `Blue color cut piece mudinjiduchu` as English (noise), not a graceful
    single-loanword degradation. Result carries a dedicated
    `transliterationSkipped` flag, and skips log to their own
    `TransliterationSkipLogEntry` array (with the error message kept on the
    record), never mixed into the guard-trip log — a run of skips (a
    sustained outage) needs to be visible at a glance, not buried among
    ordinary quality trips, or an outage would silently degrade every turn.
  - **Two separate logs**: `GuardTripLogEntry[]` (guards 1/2/3) and
    `TransliterationSkipLogEntry[]` (stage failures) — both text-only,
    in-session, in-memory accumulator + JSON-export function in
    `lib/transliterate.ts`, same *data-layer* pattern as 4a's copy-timings
    button. **Neither is mounted to any UI this slice** — there's no live
    call site to feed them, since the module isn't wired into the app
    (below). Wiring export buttons to the debug area, AND deciding whether
    skips need to surface on screen in real time (not just be logged), are
    both 4c-or-later tasks — see the open question below.
  - **Tests**: `lib/transliterate.test.mjs`, Node's built-in test runner
    (`node --test`, `npm test`) — no new dependency. 35 cases covering every
    pure function (`normalizeDigits`, `stripIntraWordHyphens`,
    `hasLatinScript`, `extractDigitSequence`, `digitSequencesEqual`,
    `isDegenerateOutput`, `otherScript`), including digits in both scripts and
    at different string positions. The model call itself is deliberately not
    tested.
  - **Regression-check coverage gap.** The 26-clip regression (against real
    model output, both pre- and post-port) exercised guard 3 (warning) and
    the happy path only — guards 1 (digit preservation) and 2 (non-empty)
    **never fired**, in either run, because no real model output happened to
    trip them. The trip→fallback→return path for guards 1/2 is covered by
    unit tests on the underlying pure functions, but **not end-to-end**
    through `guardedTransliterate` itself. Worth an integration test with a
    stubbed/mocked model response before 4c wires this into the live path.
  - **Batch pacing/retry deliberately NOT ported**, and not to be re-added by
    reflex. `scripts/eval-tts.mjs`'s `gate`/`requestOnce`/`requestWithRetry`
    (12 req/min throttle, exponential backoff, 429 handling) exists to keep a
    26-clip *batch* run under Gemini's rate limits — it doesn't belong in a
    module serving one real-time turn. The live path wants fail-fast-and-
    fall-back, not retry-with-backoff: a retry loop can cost multiple seconds
    against a ~3.3s turn budget, which is worse than falling back immediately
    to the untransliterated input.
  - **Lost capability**: `scripts/eval-tts.mjs`'s `--translit-model=` CLI flag
    is gone — the model is now fixed inside `lib/transliterate.ts` (matching
    how the module will actually be called once wired in), not
    caller-configurable. Fixing the model in the module is the right call,
    but it removes the ability to A/B a different transliteration model from
    the eval harness, and A/B comparison is exactly how the Slice 2 pipeline
    lock was decided. Noted here so its absence isn't a surprise later.
  - **NOT wired into `/api/translate` this slice.** See the 4c open question
    below — do not act on it without a decision.
- **4c open questions on `guardedTransliterate`** — unresolved, deliberately:
  1. **Wire it into the live path, or not?** Adding it puts a **third serial
     model call** on the ~3.3s translate-leg budget. `hasLatin` fired on 8/26
     (31%) of ground-truth clips in the 2026-08-15 dump — roughly a third of
     live turns would pay this latency cost if wired in at translate-time.
     Whether that's worth it (and where in the pipeline — translate-time vs.
     speak-time) is not decided here.
  2. **How do transliteration skips (network/API failures) surface?**
     Currently logged only, in-memory, no UI. A sustained outage needs to be
     visible to a user/operator in real time, not just discoverable after the
     fact in an exported log — not designed or built yet.
- **4b.2 — client-side minimum-duration gate (2026-08-15, not part of the
  original six-slice plan).** Added after a live accidental press: a 92ms tap
  (`payloadBytes` 3116 — 1536 samples after the 44-byte WAV header) was
  POSTed to `/api/translate`, and the model returned a fluent, plausible,
  domain-typical sentence (`இந்த டிசைன்ல வேற கலர் இருக்கா?`) from audio that
  cannot possibly contain it. Confirmed as an accidental press. **Input
  validation, not a model fix** — the model did what it's asked to do
  (transcribe+translate whatever audio it's given); the bug was sending audio
  that isn't speech at all.
  - **Mechanism.** `CaptureEngine.stopRecording()` (`lib/recorder.ts`) checks
    the captured sample count — not wall-clock press duration, since the two
    can diverge — before `floatToInt16`/`encodeWav` run and before the POST.
    Below threshold the turn is discarded silently: no audio sent, no error
    state, no toast (the speaker didn't mean to speak), and it's recorded in
    the debug turn list as a distinguishable `"gated"` entry (dashed styling,
    separate from a failed turn) carrying `gatedSamples`/`gatedImpliedMs`, so
    real-use trip frequency can be counted. Gated entries appear correctly in
    the copy-timings JSON export.
  - **Threshold: `MIN_TURN_MS = 300`** (→ 4800 samples at 16kHz), a single
    named constant. Derived from on-device measurement, not guessed: three
    confirmed accidental taps at 1920/120ms, 1408/88ms, 1152/72ms — all
    silently gated, none produced a network request. Real short speech passed
    clean: `சரி` at 1002/1059/1220ms, `ஆமா` at 1226/1382ms. The shortest real
    utterance measured is ~8× the longest accidental tap, so 300ms sits in
    empty space between the two populations. Threshold verified, unchanged.
  - **Stated limitation: this gate blocks accidental taps only.** It does not
    and cannot block a genuine press that captures room noise or silence —
    that press is real, deliberate, and well over 300ms. In the same test
    session, five separate no-speech turns (637/764/972/1207/1460ms, all
    comfortably above threshold) returned the character-identical fabricated
    sentence `இந்த டிசைன்ல வேற கலர் இருக்கா?` on every one. **Fabrication
    from genuine non-speech audio is unaddressed** and is not the same
    problem as the accidental-press bug this gate closes — a duration gate
    cannot solve it, because the audio duration is legitimate.
  - **Type-system follow-up (same date).** `Turn` (`lib/types.ts`) is now a
    discriminated union — `CapturedTurn` (`blob`/`mimeType`/`durationSec`
    required) vs. `SkippedTurn` (gate-trip evidence only, no audio fields at
    all) — so decision 4's raw-audio-retention guarantee is compiler-enforced
    for every real turn again, not just documented in a comment.
  - **Amplitude readout added (2026-08-16) — measurement only, no gate
    built.** `lib/recorder.ts` now computes RMS + peak amplitude from the
    Float32 samples (after the duration gate passes, before encoding) and
    surfaces both in dBFS in the debug row and `exportTurn`. Behaviourally
    inert — reads and reports, gates nothing. Desktop calibration run
    (Windows desktop Chrome, home environment with background noise,
    warm-up turns excluded):

    | Group | RMS dBFS range | n |
    |---|---|---|
    | Non-speech, quiet room | −67.0 … −62.9 | 4 |
    | Non-speech, background (TV, voices) | −65.8 … −56.9 | 4 |
    | Quiet speech | −44.3 … −24.1 | 5 |
    | Normal speech | −38.8 … −21.5 | 3 |

    - **A usable separation exists on desktop.** 12.6 dB between the loudest
      non-speech (−56.9) and the quietest speech (−44.3), with nothing in
      between. Candidate threshold **−52 dBFS RMS**, biased toward the noise
      ceiling because eating real speech is a worse failure than passing a
      fabrication.
    - **RMS is the discriminator, not peak.** The peak gap is only 7.4 dB
      (−33.6 vs −26.2) — a single transient in a silent room rivals a soft
      voice. Decide on RMS; keep peak diagnostic only.
    - **Browser noise suppression is doing much of the work.**
      Background-on non-speech sits only ~6 dB above a silent room, so the
      TV and voices were largely stripped before the samples reached us.
      The gate is therefore partly dependent on browser NS behaviour, which
      native Android may not reproduce.
    - **The threshold is not yet chosen.** These are desktop numbers —
      different mic, different AGC, different NS from the target Android
      device. Phone calibration on the deployed build comes before any
      constant is set.
    - **Fabrication reconfirmed.** All 8 non-speech turns across two
      separate page sessions returned the character-identical sentence
      `இந்த ஆர்டர் எப்ப வரும்?`, at RMS values spanning 11 dB. Twelve
      observations total now across the session.
    - **Quiet speech degrades STT before it degrades the gate.** The
      quietest speech clip (−44.3 dBFS) mis-transcribed `சரி` as `ஸாரி` — a
      second reason not to set the threshold aggressively: turns nearest
      the line are already fragile.
  - **Energy gate shipped (2026-08-16): `MIN_TURN_RMS_DBFS = -42`.** The
    gate now runs two insufficiency tests on the same discard path —
    duration (300ms) and energy (−42 dBFS RMS) — distinguished by
    `gatedReason` in the debug row and the copy-timings export.
    - **Verified on both devices (2026-08-16).** Desktop: three duration
      trips (120/128/152ms) and three energy trips (−63.2, −64.0,
      −49.5 dBFS) — both paths fire and are distinguishable,
      `gatedRmsDbfs` correctly `null` on the duration trips. Phone: three
      no-speech presses gated on energy (−74.3, −83.6, −83.9 dBFS); three
      quiet-speech turns passed and translated correctly at −18.9, −20.9,
      −22.4 dBFS. Margin on the phone: **51.9 dB** between the loudest
      gated non-speech and the quietest passing speech. Across six
      no-speech presses on two devices, **zero fabricated sentences
      reached the model.**
    - **Calibration data.** Phone non-speech: −46.8 dBFS (n=2, background
      audible) in one session, −74.3 to −83.9 dBFS in another; quiet
      speech −22.4 to −16.4 dBFS; normal speech −14.7 to −14.1 dBFS.
      Desktop: non-speech −67.0 to −56.9 dBFS; quiet speech −44.3 to
      −24.1 dBFS.
    - **Discrepancy, recorded honestly.** Phone non-speech measured
      **~30 dB quieter** in the verification session than in the
      calibration session. Unexplained — possibly a quieter room,
      possibly AGC ramp state, possibly the earlier −46.8 pair not being
      the steady state it was assumed to be. The threshold works at both
      levels observed so far, but the phone noise ceiling is **less
      firmly established than the calibration write-up implied.** If a
      loud environment pushes background above −42 dBFS, the gate stops
      firing. Confirm or revise at 4d.
    - **AGC finding.** Phone speech runs 20+ dB louder than desktop, with
      peaks at −0.1 to −2.5 dBFS. Non-speech readings were bimodal in the
      calibration session: cold-start turns measured −74.5/−75.8 dBFS,
      later turns measured −46.8 dBFS twice, agreeing to four decimal
      places in linear terms — consistent with roughly 28 dB of AGC gain
      ramping. `CaptureEngine` is persistent (Slice 3), so the ramped
      state is the operating state the threshold is calibrated against,
      not the cold-start one — though see the discrepancy note above:
      the verification session's non-speech readings sat closer to the
      cold-start range than the assumed steady state.
    - **Slice 5 note — do not act on it.** Hands-free means the mic stays
      open continuously with AGC fully ramped, so the steady-state noise
      floor may sit higher than observed here and this threshold may
      need revisiting then.
    - **Native note.** The gate depends on browser AGC and noise-suppression
      behaviour. Android native gives different, more direct control over
      both, so `-42` does not transfer as-is to a native rebuild.
    - **The threshold is provisional.** Confirmed against real presses on
      both devices with a wide margin, but the calibration/verification
      discrepancy above means the phone noise ceiling itself isn't fully
      pinned down. 4d is where it gets confirmed or revised, not this
      slice.
    - **Fabrication observed on a non-speech phone turn, before the gate
      existed:** `என்ன பண்ணிட்டு இருக்கீங்க?` — the first invented sentence
      with no commerce vocabulary at all, confirming the venue-phrase
      removal changed *what* the model invents, not *whether* it invents
      (see the Slice 2 prompt-edit subsection above). Occurred at −74.5
      and −75.8 dBFS — from near-total silence.
    - **`gatedSamples: 0` observed on the phone.** The zero-sample case is
      real, not theoretical — the duration gate caught it cleanly.
    - **The amplitude instrumentation stays in place** (debug row +
      `exportTurn`, both bullets above) until 4d confirms the threshold
      holds in real use — it's the only way a wrong threshold would be
      diagnosable rather than guessed at.
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

## Beyond the POC (native rebuild / beta) — NOT POC work, deferred deliberately

- **Guard-trip records must eventually persist permanently, with audio and
  translation attached — not just text.** 4b's guard-trip log (text-only,
  in-session, no persistence, no database) is a POC-scoped placeholder, not
  the end state.
- **All conversations — not only tripped ones — must eventually be recorded
  and persisted with audio.** Reasoning: the `ஐயாயிரம்` → `ஐயா` class of
  failure (Slice 3 findings) produces **no guard trip at all** — the
  transliterator sees perfectly valid text and every guard passes, because
  the number was already destroyed one stage upstream, in the audio-in
  transcription itself, before translation or transliteration ever ran. Text
  logging — however complete — cannot catch that class of failure; only the
  retained audio can. This is why guard-trip audio alone would be
  insufficient and full-conversation audio persistence is the actual
  requirement, not a nice-to-have.
- **Both need a storage backend the POC doesn't have.** Vercel functions are
  stateless; this project has no database (see CLAUDE.md — session state is
  React memory only). Deferred deliberately to beta, not forgotten.

## Open items

- **The venue-phrase removal from `lib/prompt.ts` (committed 2026-08-16)
  invalidates the Slice 2 native-speaker validation that locked
  `gemini-direct`.** That lock was validated against the prompt *including*
  "on a shop floor"; that prompt no longer exists. Revalidate against the
  current prompt before trusting it on a real shop floor — at 4d at the
  latest, sooner if 4c ships audio output on this prompt. See the Slice 2
  subsection above for the full before/after.
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
