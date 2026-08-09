// Slice 2 eval harness. Posts every test clip to /api/translate and reports
// latency, mustPreserve pass rate, and cost — per clip and by domain — for one
// pipeline/model, so the two providers can be compared side by side.
//
//   npm run eval                                   # default pipeline + model
//   npm run eval -- --pipeline=gemini-direct       # A/B the provider
//   npm run eval -- --pipeline=openrouter-single --model=openai/gpt-audio
//   npm run eval -- --domain=general               # subset by domain
//   npm run eval -- --file=ta-11.wav               # single clip (smoke test)
//
// Requires the dev server running (npm run dev) and the API keys in .env.local.
// Set EVAL_BASE_URL to point elsewhere (default http://localhost:3000).

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Approximate USD->INR for the "cost per rupee" view. Not authoritative.
const USD_INR = 88;

const CLIPS_DIR = "test-clips";
const GROUND_TRUTH = join(CLIPS_DIR, "ground-truth.json");
const RESULTS_DIR = "eval-results";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const pipeline = args.pipeline || "openrouter-single";
const modelArg = args.model || undefined;
const domainFilter = args.domain || undefined;
const fileFilter = args.file || undefined;
const baseUrl = args.base || process.env.EVAL_BASE_URL || "http://localhost:3000";
const endpoint = `${baseUrl}/api/translate`;

// ---------------------------------------------------------------------------
// mustPreserve normalization
// Number words (Tamil / Hindi / English) -> digits, and day names -> canonical
// English, so a token counts as present in either digit or word form. Whole-word
// (token) matching, not substring — so a model that says "15" does NOT satisfy a
// required "5" (the hi-12 failure mode).
// ---------------------------------------------------------------------------

// Compounds and scales first (longest-match-first), before single digits, so
// "आठ हज़ार" becomes 8000, not "8 1000".
const PHRASES = {
  "आठ हज़ार": "8000",
  "आठ हजार": "8000",
  எட்டாயிரம்: "8000",
  "एक हज़ार": "1000",
  "एक हजार": "1000",
  "हज़ार": "1000",
  हजार: "1000",
  ஆயிரம்: "1000",
  "eight thousand": "8000",
  "one thousand": "1000",
  thousand: "1000",
};

const UNITS = {
  // Hindi
  एक: "1", दो: "2", तीन: "3", चार: "4", "पांच": "5", "पाँच": "5",
  छह: "6", "छः": "6", सात: "7", आठ: "8", नौ: "9", दस: "10",
  // Tamil
  ஒன்று: "1", ஒன்னு: "1", ஒரு: "1", இரண்டு: "2", ரெண்டு: "2",
  மூன்று: "3", மூணு: "3", நான்கு: "4", நாலு: "4", ஐந்து: "5", அஞ்சு: "5",
  ஆறு: "6", ஏழு: "7", எட்டு: "8", ஒன்பது: "9", ஒம்பது: "9", பத்து: "10",
  // English
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};

const DAYS = {
  // English (identity)
  sunday: "sunday", monday: "monday", tuesday: "tuesday", wednesday: "wednesday",
  thursday: "thursday", friday: "friday", saturday: "saturday",
  // Hindi
  रविवार: "sunday", इतवार: "sunday", सोमवार: "monday", मंगलवार: "tuesday",
  बुधवार: "wednesday", गुरुवार: "thursday", बृहस्पतिवार: "thursday",
  शुक्रवार: "friday", शनिवार: "saturday",
  संडे: "sunday", मंडे: "monday",
  // Tamil
  ஞாயிறு: "sunday", ஞாயிற்று: "sunday", திங்கள்: "monday", செவ்வாய்: "tuesday",
  புதன்: "wednesday", வியாழன்: "thursday", வெள்ளி: "friday", சனி: "saturday",
  சண்டே: "sunday", மண்டே: "monday",
};

function replaceAllMap(text, map) {
  // Longest keys first so compounds win over their parts.
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  let out = text;
  for (const key of keys) {
    if (!key) continue;
    out = out.split(key).join(` ${map[key]} `);
  }
  return out;
}

function tokenize(text) {
  let s = text.toLowerCase();
  s = replaceAllMap(s, PHRASES);
  s = replaceAllMap(s, UNITS);
  s = replaceAllMap(s, DAYS);
  s = s.replace(/(\d+)/g, " $1 "); // split digits off adjacent script
  return s.split(/[\s.,?!।;:()"“”'’\-–—]+/u).filter(Boolean);
}

function normalizeToken(token) {
  // A needle like "Sunday"/"3D" normalizes the same way its haystack form does.
  const toks = tokenize(String(token));
  return toks.length ? toks[toks.length - 1] : String(token).toLowerCase();
}

/** Every mustPreserve token present (in digit or word form) in the translation. */
function checkMustPreserve(mustPreserve, translation) {
  if (!mustPreserve || mustPreserve.length === 0) {
    return { pass: true, tokens: [], missing: [] };
  }
  const haystack = tokenize(translation);
  const missing = [];
  for (const token of mustPreserve) {
    if (!haystack.includes(normalizeToken(token))) missing.push(token);
  }
  return { pass: missing.length === 0, tokens: mustPreserve, missing };
}

// ---------------------------------------------------------------------------
// script check — Gemini sometimes romanises the ENTIRE output ("5 hours aagum
// ma'am") instead of writing Tamil/Devanagari. Flag when the majority of the
// letters are Latin. Individual English loanwords in Latin are fine and expected
// (work, stone, blouse) — only whole-sentence romanisation trips this.
// ---------------------------------------------------------------------------
function isRomanized(text) {
  let latin = 0;
  let indic = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
    else if ((c >= 0x0b80 && c <= 0x0bff) || (c >= 0x0900 && c <= 0x097f)) indic++;
  }
  return latin + indic > 0 && latin > indic;
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------
function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function p90(xs) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1);
  return sorted[idx];
}
function usd(n) {
  return `$${n.toFixed(6)}`;
}
function inr(n) {
  return `₹${(n * USD_INR).toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
async function main() {
  const entries = JSON.parse(readFileSync(GROUND_TRUTH, "utf8")).filter((e) => {
    if (domainFilter && e.domain !== domainFilter) return false;
    if (fileFilter && e.file !== fileFilter) return false;
    return true;
  });

  if (entries.length === 0) {
    console.error("No clips matched the filter.");
    process.exit(1);
  }

  console.log(`\nEval — pipeline=${pipeline} model=${modelArg ?? "(default)"} ` +
    `domain=${domainFilter ?? "all"} clips=${entries.length}`);
  console.log(`Endpoint: ${endpoint}\n`);

  const results = [];
  for (const entry of entries) {
    const buf = readFileSync(join(CLIPS_DIR, entry.file));
    const fd = new FormData();
    fd.append("audio", new Blob([buf], { type: "audio/wav" }), entry.file);
    fd.append("sourceLang", entry.sourceLang);
    fd.append("pipeline", pipeline);
    if (modelArg) fd.append("model", modelArg);

    const started = Date.now();
    let record;
    try {
      const res = await fetch(endpoint, { method: "POST", body: fd });
      const elapsedMs = Date.now() - started;
      const json = await res.json();
      if (!res.ok) {
        record = { ...base(entry, elapsedMs), error: json.error || `HTTP ${res.status}`, detail: json.detail };
      } else {
        const mp = checkMustPreserve(entry.mustPreserve, json.translation);
        record = {
          ...base(entry, elapsedMs),
          model: json.model,
          original: json.original,
          translation: json.translation,
          mustPreservePass: mp.pass,
          mustPreserveMissing: mp.missing,
          romanized: isRomanized(json.translation),
          usage: json.usage,
        };
      }
    } catch (err) {
      record = { ...base(entry, Date.now() - started), error: String(err?.message ?? err) };
    }
    results.push(record);
    printClip(record);
  }

  printSummary(results);
  writeResults(results);
}

function base(entry, elapsedMs) {
  return {
    file: entry.file,
    sourceLang: entry.sourceLang,
    domain: entry.domain,
    elapsedMs,
    expectedTranslation: entry.expectedTranslation,
    mustPreserve: entry.mustPreserve,
  };
}

function mpLabel(record) {
  if (record.error) return "ERROR";
  if (!record.mustPreserve || record.mustPreserve.length === 0) return "—";
  return record.mustPreservePass ? "PASS" : "FAIL";
}

function printClip(r) {
  const cost = r.usage ? `${usd(r.usage.costUsd)} (${inr(r.usage.costUsd)})` : "—";
  const tokens = r.usage
    ? `in=${r.usage.promptTokens} audio=${r.usage.audioTokens} out=${r.usage.completionTokens}`
    : "";
  console.log(
    `[${r.file}] ${r.domain.padEnd(9)} ${String(r.elapsedMs).padStart(5)}ms  ` +
      `cost ${cost}  ${tokens}  mustPreserve: ${mpLabel(r)}` +
      (r.mustPreserveMissing?.length ? ` (missing ${r.mustPreserveMissing.join(", ")})` : "") +
      (r.romanized ? "  [ROMANIZED]" : ""),
  );
  if (r.error) {
    console.log(`  ERROR: ${r.error}${r.detail ? ` — ${r.detail}` : ""}`);
  } else {
    console.log(`  orig: ${r.original}`);
    console.log(`  xltn: ${r.translation}`);
    console.log(`  want: ${r.expectedTranslation}`);
  }
  console.log("");
}

function summaryFor(rows) {
  const ok = rows.filter((r) => !r.error);
  const latencies = ok.map((r) => r.elapsedMs);
  const costs = ok.map((r) => r.usage?.costUsd ?? 0);
  const withTokens = rows.filter((r) => !r.error && r.mustPreserve?.length);
  const passed = withTokens.filter((r) => r.mustPreservePass);
  const romanized = ok.filter((r) => r.romanized);
  return {
    clips: rows.length,
    errors: rows.length - ok.length,
    okCount: ok.length,
    meanMs: Math.round(mean(latencies)),
    p90Ms: Math.round(p90(latencies)),
    mustPreserveTotal: withTokens.length,
    mustPreservePassed: passed.length,
    mustPreserveRate: withTokens.length ? passed.length / withTokens.length : null,
    romanizedCount: romanized.length,
    romanizedRate: ok.length ? romanized.length / ok.length : null,
    meanCostUsd: mean(costs),
    totalCostUsd: costs.reduce((a, b) => a + b, 0),
  };
}

function printSummary(results) {
  const line = "─".repeat(72);
  console.log(line);
  console.log("SUMMARY");
  console.log(line);

  const overall = summaryFor(results);
  printSummaryRow("all", overall);

  const domains = [...new Set(results.map((r) => r.domain))].sort();
  for (const d of domains) {
    printSummaryRow(d, summaryFor(results.filter((r) => r.domain === d)));
  }
  console.log(line);
}

function printSummaryRow(label, s) {
  const rate =
    s.mustPreserveRate === null
      ? "n/a"
      : `${(s.mustPreserveRate * 100).toFixed(0)}% (${s.mustPreservePassed}/${s.mustPreserveTotal})`;
  const rom =
    s.romanizedRate === null
      ? "n/a"
      : `${(s.romanizedRate * 100).toFixed(0)}% (${s.romanizedCount}/${s.okCount})`;
  console.log(
    `${label.padEnd(10)} clips=${String(s.clips).padStart(2)} errors=${s.errors}  ` +
      `latency mean=${String(s.meanMs).padStart(5)}ms p90=${String(s.p90Ms).padStart(5)}ms  ` +
      `mustPreserve=${rate}  romanized=${rom}  ` +
      `cost mean=${usd(s.meanCostUsd)} total=${usd(s.totalCostUsd)} (${inr(s.totalCostUsd)})`,
  );
}

function writeResults(results) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const modelUsed = (results.find((r) => r.model)?.model || modelArg || "default").replace(/[\\/]/g, "_");
  const path = join(RESULTS_DIR, `${stamp}-${pipeline}-${modelUsed}.json`);
  const payload = {
    meta: {
      timestamp: new Date().toISOString(),
      pipeline,
      model: modelArg ?? modelUsed,
      baseUrl,
      domainFilter: domainFilter ?? null,
      fileFilter: fileFilter ?? null,
      usdInr: USD_INR,
    },
    summary: {
      all: summaryFor(results),
      byDomain: Object.fromEntries(
        [...new Set(results.map((r) => r.domain))].map((d) => [
          d,
          summaryFor(results.filter((r) => r.domain === d)),
        ]),
      ),
    },
    results,
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  console.log(`\nResults written to ${path}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
