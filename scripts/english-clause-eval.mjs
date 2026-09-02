// One-off baseline for the Slice 5 "whole English clauses pass through
// untranslated" investigation (docs/PLAN.md -> Slice 5, Item 1). Posts every
// real-device WAV under test-clips/english-clause/ to /api/translate and
// records original/translation/debug per clip, so today's model behaviour on
// these clips is on record before anything about the prompt or pipeline
// changes. Read-only against the app: this script does not touch the
// translate prompt, any route, or the existing 26-clip harness.
//
// These WAVs are byte-identical to what the app itself POSTed for these real
// turns (filenames are the first 8 characters of the turn id), so at
// temperature 0 on the locked gemini-direct pipeline, re-sending them
// reproduces the original real-device result.
//
//   node scripts/english-clause-eval.mjs
//   EVAL_BASE_URL=https://... node scripts/english-clause-eval.mjs
//
// Requires the dev server running (npm run dev) and the API keys in
// .env.local — same requirement as scripts/eval.mjs. Base URL is supplied
// the same way: EVAL_BASE_URL env var, else http://localhost:3000, else a
// --base= override.

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Same reasoning as scripts/eval.mjs: one source of truth for the default
// pipeline, so this script can't silently disagree with the endpoint about
// which provider is the default one.
import { DEFAULT_PIPELINE } from "../lib/models.ts";

const CLIPS_DIR = join("test-clips", "english-clause");
// Every clip in this set is a Tamil-side real-device capture (see the task
// context this script was built against) — not read from filenames or a
// manifest, because none carries that information.
const SOURCE_LANG = "ta";
// Sequential requests, not parallel, with a short gap between them — mirrors
// the app's own one-request-at-a-time-per-press shape and avoids hammering a
// local dev server or the provider back to back.
const REQUEST_DELAY_MS = 500;

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const baseUrl = args.base || process.env.EVAL_BASE_URL || "http://localhost:3000";
const endpoint = `${baseUrl}/api/translate`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Enumerated, not hardcoded, so clips can be added to the directory later
// without editing this script. Sorted for a deterministic run order.
function listClips() {
  return readdirSync(CLIPS_DIR)
    .filter((name) => name.toLowerCase().endsWith(".wav"))
    .sort();
}

// Same FormData shape as scripts/eval.mjs's request construction: an "audio"
// Blob (type audio/wav, original filename) plus "sourceLang" and "pipeline".
async function translateClip(file) {
  const buf = readFileSync(join(CLIPS_DIR, file));
  const fd = new FormData();
  fd.append("audio", new Blob([buf], { type: "audio/wav" }), file);
  fd.append("sourceLang", SOURCE_LANG);
  fd.append("pipeline", DEFAULT_PIPELINE);

  const started = Date.now();
  try {
    const res = await fetch(endpoint, { method: "POST", body: fd });
    const elapsedMs = Date.now() - started;
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null; // malformed/non-JSON body — fall through as a recorded failure
    }
    if (!res.ok) {
      return {
        file,
        status: res.status,
        elapsedMs,
        original: null,
        translation: null,
        debug: json?.debug ?? null,
        error: (json && json.error) || `HTTP ${res.status}`,
        detail: json?.detail ?? null,
      };
    }
    return {
      file,
      status: res.status,
      elapsedMs,
      original: typeof json?.original === "string" ? json.original : null,
      translation: typeof json?.translation === "string" ? json.translation : null,
      debug: json?.debug ?? null,
      error: null,
      detail: null,
    };
  } catch (err) {
    // Network failure, timeout, or anything else thrown by fetch itself —
    // recorded like any other failure, never abandons the run.
    return {
      file,
      status: null,
      elapsedMs: Date.now() - started,
      original: null,
      translation: null,
      debug: null,
      error: String(err?.message ?? err),
      detail: null,
    };
  }
}

function printClip(r) {
  if (r.error) {
    console.log(
      `[${r.file}] ERROR (status ${r.status ?? "n/a"}): ${r.error}${r.detail ? ` — ${r.detail}` : ""}`,
    );
    return;
  }
  console.log(`[${r.file}] ${r.elapsedMs}ms`);
  console.log(`  orig: ${r.original}`);
  console.log(`  xltn: ${r.translation}`);
}

function writeResults(results) {
  mkdirSync(CLIPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(CLIPS_DIR, `baseline-${stamp}.json`);
  writeFileSync(path, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${path}\n`);
  return path;
}

async function main() {
  const files = listClips();
  if (files.length === 0) {
    console.error(`No .wav files found in ${CLIPS_DIR}.`);
    process.exit(1);
  }

  console.log(
    `English-clause baseline — pipeline=${DEFAULT_PIPELINE} sourceLang=${SOURCE_LANG} clips=${files.length}`,
  );
  console.log(`Endpoint: ${endpoint}\n`);

  const results = [];
  for (let i = 0; i < files.length; i++) {
    const record = await translateClip(files[i]);
    results.push(record);
    printClip(record);
    if (i < files.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  const errors = results.filter((r) => r.error).length;
  console.log(`\nDone — ${results.length} clips, ${errors} error(s).`);
  writeResults(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
