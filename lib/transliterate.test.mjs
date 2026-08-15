// Unit tests for the PURE functions in lib/transliterate.ts only — the model
// call (requestTransliteration / guardedTransliterate) is deliberately not
// tested here, per instruction. Written as .mjs (not .ts) and importing
// "./transliterate.ts" WITH the extension: this file sits outside tsconfig's
// **/*.ts sweep, so it's free to use an explicit .ts specifier the way
// scripts/eval.mjs and scripts/eval-tts.mjs already do for their lib/
// imports — the same reason lib/transliterate.ts itself avoids extensionless
// real imports (see the comment at the top of that file).
//
// Run: node --test lib/transliterate.test.mjs  (also `npm test`)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDigits,
  stripIntraWordHyphens,
  hasLatinScript,
  extractDigitSequence,
  digitSequencesEqual,
  isDegenerateOutput,
  otherScript,
} from "./transliterate.ts";

// ---------------------------------------------------------------------------
// otherScript
// ---------------------------------------------------------------------------
test("otherScript: ta source targets Devanagari", () => {
  assert.equal(otherScript("ta"), "Devanagari (Hindi) script");
});
test("otherScript: hi source targets Tamil script", () => {
  assert.equal(otherScript("hi"), "Tamil script");
});

// ---------------------------------------------------------------------------
// normalizeDigits
// ---------------------------------------------------------------------------
test("normalizeDigits: Devanagari digits to ASCII", () => {
  assert.equal(normalizeDigits("८०००"), "8000");
});
test("normalizeDigits: Tamil digits to ASCII", () => {
  assert.equal(normalizeDigits("௫"), "5");
});
test("normalizeDigits: already-ASCII digits are a no-op", () => {
  assert.equal(normalizeDigits("8000"), "8000");
});
test("normalizeDigits: mixed script digits within one string", () => {
  assert.equal(normalizeDigits("८ and ௫ and 3"), "8 and 5 and 3");
});
test("normalizeDigits: digits embedded in surrounding script text", () => {
  assert.equal(normalizeDigits("இது ८௦ ரூபாய்"), "இது 80 ரூபாய்");
});

// ---------------------------------------------------------------------------
// stripIntraWordHyphens
// ---------------------------------------------------------------------------
test("stripIntraWordHyphens: intra-word hyphen removed (Tamil)", () => {
  assert.equal(stripIntraWordHyphens("வொர்க்-கு"), "வொர்க்கு");
});
test("stripIntraWordHyphens: intra-word hyphen removed (Devanagari)", () => {
  assert.equal(stripIntraWordHyphens("पॉप-आउट"), "पॉपआउट");
});
test("stripIntraWordHyphens: spaced hyphen (word boundary) is preserved", () => {
  assert.equal(stripIntraWordHyphens("work - done"), "work - done");
});
test("stripIntraWordHyphens: leading hyphen (no preceding non-whitespace) is preserved", () => {
  assert.equal(stripIntraWordHyphens("-कु"), "-कु");
});
test("stripIntraWordHyphens: en-dash and em-dash also stripped intra-word", () => {
  assert.equal(stripIntraWordHyphens("a–b"), "ab"); // en dash
  assert.equal(stripIntraWordHyphens("a—b"), "ab"); // em dash
});
test("stripIntraWordHyphens: no hyphen is a no-op", () => {
  assert.equal(stripIntraWordHyphens("வொர்க்கு"), "வொர்க்கு");
});
test("stripIntraWordHyphens: a digit range collapses (documented risk, guard 1 is the real protection)", () => {
  assert.equal(stripIntraWordHyphens("3-4 hours"), "34 hours");
});

// ---------------------------------------------------------------------------
// hasLatinScript
// ---------------------------------------------------------------------------
test("hasLatinScript: pure Tamil has no Latin", () => {
  assert.equal(hasLatinScript("சரி மேம்."), false);
});
test("hasLatinScript: pure Devanagari has no Latin", () => {
  assert.equal(hasLatinScript("ठीक है"), false);
});
test("hasLatinScript: embedded loanword detected", () => {
  assert.equal(hasLatinScript("நாளைக்கு work இருக்கா?"), true);
});
test("hasLatinScript: whole-sentence romanisation detected", () => {
  assert.equal(hasLatinScript("Blue color cut piece mudinjiduchu."), true);
});
test("hasLatinScript: digits/punctuation alone are not Latin letters", () => {
  assert.equal(hasLatinScript("8000, சார்!"), false);
});

// ---------------------------------------------------------------------------
// extractDigitSequence
// ---------------------------------------------------------------------------
test("extractDigitSequence: ASCII digits", () => {
  assert.deepEqual(extractDigitSequence("8000 का बिल"), ["8000"]);
});
test("extractDigitSequence: Devanagari digits", () => {
  assert.deepEqual(extractDigitSequence("८००० का बिल"), ["8000"]);
});
test("extractDigitSequence: Tamil digits", () => {
  assert.deepEqual(extractDigitSequence("௮௦௦௦ ரூபாய்"), ["8000"]);
});
test("extractDigitSequence: digit at string start", () => {
  assert.deepEqual(extractDigitSequence("5 hours aagum"), ["5"]);
});
test("extractDigitSequence: digit at string end", () => {
  assert.deepEqual(extractDigitSequence("charge panna mudiyuma 1000"), ["1000"]);
});
test("extractDigitSequence: multiple separate digit runs, order preserved", () => {
  assert.deepEqual(extractDigitSequence("2 blouses, 8000 rupees, day 5"), ["2", "8000", "5"]);
});
test("extractDigitSequence: no digits present", () => {
  assert.deepEqual(extractDigitSequence("நாளைக்கு work இருக்கா?"), []);
});
test("extractDigitSequence: mixed-script digits within one string, in order", () => {
  assert.deepEqual(extractDigitSequence("८ then ௫ then 3"), ["8", "5", "3"]);
});

// ---------------------------------------------------------------------------
// digitSequencesEqual
// ---------------------------------------------------------------------------
test("digitSequencesEqual: equal arrays", () => {
  assert.equal(digitSequencesEqual(["8000"], ["8000"]), true);
});
test("digitSequencesEqual: different length", () => {
  assert.equal(digitSequencesEqual(["8000"], ["8000", "5"]), false);
});
test("digitSequencesEqual: same length, different content", () => {
  assert.equal(digitSequencesEqual(["8000"], ["5000"]), false);
});
test("digitSequencesEqual: order matters", () => {
  assert.equal(digitSequencesEqual(["2", "5"], ["5", "2"]), false);
});
test("digitSequencesEqual: both empty", () => {
  assert.equal(digitSequencesEqual([], []), true);
});

// ---------------------------------------------------------------------------
// isDegenerateOutput
// ---------------------------------------------------------------------------
test("isDegenerateOutput: empty string", () => {
  assert.equal(isDegenerateOutput(""), true);
});
test("isDegenerateOutput: whitespace-only string", () => {
  assert.equal(isDegenerateOutput("   \n\t "), true);
});
test("isDegenerateOutput: real content is not degenerate", () => {
  assert.equal(isDegenerateOutput("வொர்க்கு"), false);
});
