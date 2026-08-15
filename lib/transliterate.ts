import type { Side } from "./types";

/**
 * Slice 4b: the Latin-loanword transliterator, promoted from
 * scripts/eval-tts.mjs into a testable lib module. NOT wired into
 * /api/translate this slice — see PLAN.md's 4c open question.
 *
 * The transliteration itself stays a Gemini call, deliberately. The 26-clip
 * dump (2026-08-15) showed 5/8 triggered clips arrive with the ENTIRE
 * sentence romanised in an ad-hoc scheme ("Blue color cut piece
 * mudinjiduchu, naaliku eduthutu vaanga") — arbitrary Tamil/Hindi vocabulary
 * spelled out phonetically in Latin letters, not a loanword sitting in
 * otherwise-correct script. A lookup table maps known tokens to known
 * outputs; it can't invert an open-vocabulary phonetic respelling of a
 * language it doesn't otherwise touch. See PLAN.md's dead-end note — do not
 * re-propose a table-based approach without a fundamentally different input
 * shape than "whatever Gemini's translation happened to romanise."
 *
 * What IS pure and testable here is the guard layer wrapped around the call:
 * digit preservation and non-empty output are hard guards that fall back to
 * the untransliterated input; script purity is a warning that never rejects.
 *
 * No import of ./prompt or any other real (non-type) sibling module here,
 * deliberately: scripts/eval-tts.mjs imports this file directly via plain
 * `node` (not through Next's bundler), and plain Node's ESM resolver cannot
 * resolve extensionless relative specifiers to a .ts file — confirmed the
 * hard way earlier this session (lib/translate/validate.ts's extensionless
 * `./types` import broke a standalone script that tried to import it). Adding
 * `.ts` extensions instead isn't an option either: this file IS typechecked
 * by tsc (tsconfig's "every .ts file" include glob) and
 * `allowImportingTsExtensions` isn't enabled, so an explicit `.ts` specifier
 * would break `npm run build`. Net
 * result: this file's only sibling import is the type-only one below (erased
 * before resolution, always safe); a tiny local `directionLabel` replaces the
 * one line of real logic that would otherwise have come from ./prompt.
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const XLIT_MODEL = "gemini-3.1-flash-lite";

// ---------------------------------------------------------------------------
// Pure functions — unit tested (lib/transliterate.test.mjs), no network.
// ---------------------------------------------------------------------------

/** Ported unchanged from scripts/eval-tts.mjs's otherScript(). */
export function otherScript(sourceLang: Side): string {
  return sourceLang === "ta" ? "Devanagari (Hindi) script" : "Tamil script";
}

function directionLabel(sourceLang: Side): string {
  return sourceLang === "ta" ? "ta→hi" : "hi→ta";
}

/**
 * Ported unchanged from scripts/eval-tts.mjs's normalizeDigits(). Maps any
 * Devanagari (०-९) or Tamil (௦-௯) digit back to ASCII, so a script-only digit
 * substitution can never register as a content change — the only difference a
 * transliteration should make is to the loanword letters, never the digits.
 */
export function normalizeDigits(s: string): string {
  return s.replace(/[०-९௦-௯]/g, (ch) => {
    const c = ch.codePointAt(0)!;
    const base = c >= 0x0be6 ? 0x0be6 : 0x0966;
    return String(c - base);
  });
}

/**
 * Ported unchanged from scripts/eval-tts.mjs's inline hyphen-strip. This is a
 * Gemini TTS API 400 WORKAROUND, not a quality/correctness check: an
 * intra-word hyphen the transliterator sometimes inserts (e.g. "வொர்க்-கு")
 * makes Gemini TTS reject the text with "tried to generate text ... should
 * only be used for TTS". Do not refactor this away as redundant with the
 * transliteration prompt asking the model not to do this — it does it anyway
 * often enough (2/8 triggered clips in the 26-clip dump) to stay load-bearing.
 */
export function stripIntraWordHyphens(s: string): string {
  return s.replace(/(?<=\S)[-–—](?=\S)/gu, "");
}

/**
 * True if `text` contains any Latin letter. Used at two points: as the
 * initial trigger gate (does this translation need transliteration at all —
 * matches scripts/eval-tts.mjs's original `hasLatin` check exactly) and as
 * guard 3, script purity, on the output.
 */
export function hasLatinScript(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

/**
 * Ordered digit-run extraction, script-agnostic: normalizes digits to ASCII
 * FIRST, then extracts. Without normalizing first, a Devanagari/Tamil digit on
 * one side of a comparison and its ASCII equivalent on the other would
 * register as a false mismatch (or worse, a false MATCH if `\d` simply fails
 * to see either) — normalizing first makes this reliable regardless of which
 * script a digit shows up in on either side of the guard-1 comparison.
 */
export function extractDigitSequence(text: string): string[] {
  return normalizeDigits(text).match(/\d+/g) ?? [];
}

/** Order-sensitive equality for two digit-run arrays (guard 1's comparison). */
export function digitSequencesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** Guard 2: empty or whitespace-only text. */
export function isDegenerateOutput(text: string): boolean {
  return text.trim().length === 0;
}

// ---------------------------------------------------------------------------
// The generative call — NOT pure, NOT unit tested (network + model call).
// Behaviourally unchanged from scripts/eval-tts.mjs's transliterate(): same
// prompt, same model, same two post-processing steps in the same order
// (normalizeDigits, then the hyphen strip). Split into a raw/final pair so the
// guard layer above can see both. Deliberately NOT ported: the batch-eval
// pacing/retry/backoff machinery (gate/requestOnce/requestWithRetry) that
// scripts/eval-tts.mjs's transliterate() shared with its TTS calls — that's
// infrastructure for a 26-clip BATCH run risking rate limits, not a property
// of "the transliterator" itself. This uses a plain fetch + throw-on-!ok,
// matching the style already established in lib/translate/gemini-direct.ts.
// Flagged explicitly: if retry/pacing behaviour needs preserving too, say so.
// ---------------------------------------------------------------------------

interface RawTransliteration {
  rawModelOutput: string;
  /** After normalizeDigits, then stripIntraWordHyphens — in that order. */
  finalOutput: string;
  costUsd: number;
}

interface GeminiPart {
  text?: string;
}

async function requestTransliteration(text: string, sourceLang: Side): Promise<RawTransliteration> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const prompt =
    `Rewrite the text below so any words currently in Latin/English letters are ` +
    `written phonetically in ${otherScript(sourceLang)}. Keep the meaning, wording, ` +
    `and order identical. Do NOT change any digits or numbers — leave every digit ` +
    `exactly as written, in the same Latin/Arabic numerals (e.g. 8000 stays 8000). ` +
    `Output only the rewritten text.\n\nText: ${text}`;

  const res = await fetch(`${GEMINI_BASE}/${XLIT_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  const parts: GeminiPart[] = json?.candidates?.[0]?.content?.parts ?? [];
  const rawModelOutput = parts
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  const finalOutput = stripIntraWordHyphens(normalizeDigits(rawModelOutput));
  const um = json?.usageMetadata ?? {};
  const promptTokens: number = um.promptTokenCount ?? 0;
  const completionTokens: number = um.candidatesTokenCount ?? 0;
  // gemini-3.1-flash-lite text pricing, USD per 1M tokens — same figures
  // scripts/eval-tts.mjs used (XLIT_TEXT_IN_PER_M / XLIT_TEXT_OUT_PER_M).
  const costUsd = (promptTokens * 0.25 + completionTokens * 1.5) / 1e6;
  return { rawModelOutput, finalOutput, costUsd };
}

// ---------------------------------------------------------------------------
// Guard-trip log — in-session accumulation, same pattern as 4a's
// copy-timings: an in-memory array plus a JSON export function. NOT wired to
// any UI this slice (the module itself isn't wired into /api/translate — see
// PLAN.md's 4c open question), so this is the data-layer half of that
// eventual debug-area affordance, not a mounted feature yet.
// ---------------------------------------------------------------------------

/**
 * Only the three real guards. A network/API failure is a DIFFERENT failure
 * class — a guard trip means the model answered and a guard rejected the
 * answer; a network error means the transliteration stage never ran at all.
 * Keeping them out of the same union/log is deliberate (see the skip log
 * below and the catch site in guardedTransliterate).
 */
export type GuardName = "digit-preservation" | "non-empty" | "script-purity";

export interface GuardTripLogEntry {
  timestamp: string;
  /** "ta→hi" | "hi→ta" */
  direction: string;
  /** STT `original` text, kept ONLY for log correlation — never sent to the
   * model. Lets a trip be checked against a bad transcription upstream. See
   * PLAN.md's beta-persistence note for why text-only logging still can't
   * catch every upstream failure class (the ஐயாயிரம்→ஐயா case specifically). */
  original: string;
  /** The transliterator's actual input — the translation text. */
  input: string;
  rawModelOutput: string;
  guard: GuardName;
  /** Guard 1 only. */
  inputDigits?: string[];
  /** Guard 1 only. */
  outputDigits?: string[];
  /** True for guards 1/2 (both fall back); always false for guard 3
   * (script-purity never falls back, it only warns). */
  fallbackFired: boolean;
}

const guardTripLog: GuardTripLogEntry[] = [];

function logTrip(entry: GuardTripLogEntry): void {
  guardTripLog.push(entry);
}

export function getGuardTripLog(): readonly GuardTripLogEntry[] {
  return guardTripLog;
}

export function exportGuardTripLogJSON(): string {
  return JSON.stringify(guardTripLog, null, 2);
}

/** Test-only: clears the in-session log between test cases. */
export function clearGuardTripLog(): void {
  guardTripLog.length = 0;
}

/**
 * A transliteration attempt that never produced a model answer at all
 * (network failure, non-2xx response, missing API key). Structurally
 * separate from GuardTripLogEntry — see the module-level comment on
 * GuardName. Kept as its own array specifically so a RUN of these (a
 * sustained outage) is visible at a glance instead of buried among
 * individual quality trips: a guard trip here or there is expected noise,
 * but ten skips in a row is an incident.
 */
export interface TransliterationSkipLogEntry {
  timestamp: string;
  /** "ta→hi" | "hi→ta" */
  direction: string;
  /** STT `original` text — log correlation only, never sent to the model. */
  original: string;
  /** The transliterator's actual input — the translation text. */
  input: string;
  /** The thrown error's message — kept on the record, not swallowed. */
  error: string;
}

const transliterationSkipLog: TransliterationSkipLogEntry[] = [];

function logSkip(entry: TransliterationSkipLogEntry): void {
  transliterationSkipLog.push(entry);
}

export function getTransliterationSkipLog(): readonly TransliterationSkipLogEntry[] {
  return transliterationSkipLog;
}

export function exportTransliterationSkipLogJSON(): string {
  return JSON.stringify(transliterationSkipLog, null, 2);
}

/** Test-only: clears the in-session log between test cases. */
export function clearTransliterationSkipLog(): void {
  transliterationSkipLog.length = 0;
}

// ---------------------------------------------------------------------------
// The guarded entry point.
// ---------------------------------------------------------------------------

export interface GuardedTransliterateInput {
  /** STT `original` text — log correlation only, never sent to the model. */
  original: string;
  /** The transliterator's actual input — the translation text. */
  translation: string;
  sourceLang: Side;
}

export interface GuardedTransliterateResult {
  /** The text to actually use: transliterated+guarded, or the untouched
   * `translation` on a hard-guard trip OR a skip. */
  text: string;
  /** Whether the transliterator was even invoked — false when `translation`
   * had no Latin characters (matches the original hasLatin gate exactly). */
  triggered: boolean;
  /** True if `text` fell back to the untransliterated `translation`, for
   * EITHER reason (a hard guard trip or a skip). A consumer that only cares
   * "is this the guarded output or the raw input" needs just this field. */
  usedFallback: boolean;
  /** True specifically when the transliteration STAGE NEVER RAN TO COMPLETION
   * (network/API failure) — distinct from a hard guard trip, where the model
   * DID answer and a guard rejected it. See the module-level GuardName
   * comment for why these are kept separate. */
  transliterationSkipped: boolean;
  rawModelOutput: string | null;
  /** Guard 3 — Latin survived transliteration. Never causes a fallback. */
  scriptPurityWarning: boolean;
  costUsd: number;
}

/**
 * The single entry point: transliterate `translation` if (and only if) it
 * contains Latin script, guarded. Hard guards (digit preservation, non-empty)
 * fall back to the untransliterated input on failure — degrade toward ugly
 * (an unconverted loanword), never toward wrong (a mangled number) or toward
 * nothing (a thrown error killing the turn).
 *
 * A thrown network/API error gets the SAME fallback (keep the turn alive —
 * failing it outright is worse) but is a DIFFERENT category, logged
 * separately as a skip, not a guard trip: 5 of 8 triggered clips in the
 * 26-clip dump were FULLY romanised sentences ("Blue color cut piece
 * mudinjiduchu, naaliku eduthutu vaanga"), so a skip on one of those means
 * TTS reads the whole sentence as English — noise, not a graceful
 * degradation of a single loanword. Separating the two logs means a
 * SUSTAINED outage (many skips in a row) is visible at a glance instead of
 * being buried among individual, expected quality trips — otherwise a
 * Gemini outage degrades every turn silently. Surfacing skips on screen in
 * real time is a 4c open question (see PLAN.md); not built here.
 */
export async function guardedTransliterate(
  input: GuardedTransliterateInput,
): Promise<GuardedTransliterateResult> {
  const { original, translation, sourceLang } = input;

  if (!hasLatinScript(translation)) {
    return {
      text: translation,
      triggered: false,
      usedFallback: false,
      transliterationSkipped: false,
      rawModelOutput: null,
      scriptPurityWarning: false,
      costUsd: 0,
    };
  }

  const direction = directionLabel(sourceLang);
  let raw: RawTransliteration;
  try {
    raw = await requestTransliteration(translation, sourceLang);
  } catch (err) {
    logSkip({
      timestamp: new Date().toISOString(),
      direction,
      original,
      input: translation,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      text: translation,
      triggered: true,
      usedFallback: true,
      transliterationSkipped: true,
      rawModelOutput: null,
      scriptPurityWarning: false,
      costUsd: 0,
    };
  }

  const { rawModelOutput, finalOutput, costUsd } = raw;

  // Guard 2 — non-empty/non-degenerate (hard).
  if (isDegenerateOutput(finalOutput)) {
    logTrip({
      timestamp: new Date().toISOString(),
      direction,
      original,
      input: translation,
      rawModelOutput,
      guard: "non-empty",
      fallbackFired: true,
    });
    return {
      text: translation,
      triggered: true,
      usedFallback: true,
      transliterationSkipped: false,
      rawModelOutput,
      scriptPurityWarning: false,
      costUsd,
    };
  }

  // Guard 1 — digit preservation (hard). Compared against the FINAL output
  // (after normalizeDigits AND the hyphen strip), not the raw model text:
  // either post-processing step could in principle alter a digit run — e.g.
  // the hyphen strip isn't restricted to script letters, so a legitimate
  // "3-4" range would collapse to "34" if it ever appeared. Checking the
  // truly final text is what actually protects the number, since that's the
  // text that would be used.
  const inputDigits = extractDigitSequence(translation);
  const outputDigits = extractDigitSequence(finalOutput);
  if (!digitSequencesEqual(inputDigits, outputDigits)) {
    logTrip({
      timestamp: new Date().toISOString(),
      direction,
      original,
      input: translation,
      rawModelOutput,
      guard: "digit-preservation",
      inputDigits,
      outputDigits,
      fallbackFired: true,
    });
    return {
      text: translation,
      triggered: true,
      usedFallback: true,
      transliterationSkipped: false,
      rawModelOutput,
      scriptPurityWarning: false,
      costUsd,
    };
  }

  // Guard 3 — script purity (warning only, never a rejection). The
  // transliterated text is used either way: a mispronounced word is still
  // comprehensible, rejecting the whole utterance is not.
  const scriptPurityWarning = hasLatinScript(finalOutput);
  if (scriptPurityWarning) {
    logTrip({
      timestamp: new Date().toISOString(),
      direction,
      original,
      input: translation,
      rawModelOutput,
      guard: "script-purity",
      fallbackFired: false,
    });
  }

  return {
    text: finalOutput,
    triggered: true,
    usedFallback: false,
    transliterationSkipped: false,
    rawModelOutput,
    scriptPurityWarning,
    costUsd,
  };
}
