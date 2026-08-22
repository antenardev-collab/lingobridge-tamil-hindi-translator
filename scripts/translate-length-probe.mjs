// Exercises the DEPLOYED /api/translate route to separate latency that tracks
// INPUT length (audio tokens) from latency that tracks OUTPUT length
// (completion tokens).
//
// scripts/translate-gap-probe.mjs proved serving variance exists even at
// fixed input — 25 identical requests to hi-11.wav ranged 731-2234ms in
// requestToCompleteMs. That result did not explain the larger spread seen on
// real device turns, where clips differ in both audio duration and expected
// output length. This probe holds the idle gap at zero (so gap-driven
// variance from the other probe doesn't leak in) and varies the clip instead,
// across six clips deliberately chosen to spread expected-output length
// widely and to include one clip where duration and output length diverge in
// each direction (long audio/short output, short audio/long output) — see
// the selection rationale recorded against the run that generated this file.
//
// The distinction decides whether streaming STT is the right latency fix:
// streaming STT only helps if the cost tracks input (audio) length. If it
// tracks output (completion) length instead, the cost is in generation, and
// streaming STT would not move it.
//
//   node scripts/translate-length-probe.mjs
//
// No dependencies — Node built-ins and global fetch only. No API key needed:
// the deployed route holds GEMINI_API_KEY/OPENROUTER_API_KEY server-side; this
// script only ever talks to our own /api/translate. Mirrors
// scripts/translate-gap-probe.mjs's structure/output/labelling; that file
// (and scripts/translate-route-probe.mjs) are left untouched.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.env.PROBE_BASE_URL || "https://lingobridge-tamil-hindi-translator.vercel.app";

const CLIP_DIR = "test-clips";

/**
 * Six clips, hardcoded. Selection made against test-clips/ground-truth.json,
 * sorted by expectedTranslation character length (a proxy for output tokens
 * only — the run itself measures the real completionTokens):
 *
 *   - hi-11.wav: mandatory. Anchors this run to translate-gap-probe.mjs's
 *     results (same clip, zero gap).
 *   - hi-01.wav: LONG duration (5.97s, 2nd-longest in the corpus) but SHORT
 *     expected output (42 chars) relative to its duration peers (the other
 *     eight clips at 5.29-6.19s all sit at 58-77 chars). Breaks the
 *     duration/output correlation on the long-input/short-output side.
 *   - ta-02.wav: SHORT duration (3.88s, below the corpus median of ~4.0s)
 *     but LONG expected output (47 chars, above the corpus median of ~41.5)
 *     — longer than ta-01/ta-07 despite a shorter clip (4.14s, 41/33 chars).
 *     Breaks the correlation on the short-input/long-output side. This is
 *     the best available inversion in the corpus, not a dramatic one — no
 *     clip under ~3s duration has a long expected output, so a stronger
 *     example does not exist and none is substituted for it.
 *   - ta-12.wav: extreme LOW end of expected-output length (3 chars, "कल?").
 *   - ta-10.wav: extreme HIGH end of expected-output length (77 chars).
 *   - hi-09.wav: mid-range pick (24 chars) so the six span the length range
 *     roughly evenly rather than clustering at the extremes; also balances
 *     the set to 3 Hindi-source / 3 Tamil-source clips.
 */
const CLIPS = [
  { file: "hi-11.wav", sourceLang: "hi" },
  { file: "hi-01.wav", sourceLang: "hi" },
  { file: "ta-02.wav", sourceLang: "ta" },
  { file: "ta-12.wav", sourceLang: "ta" },
  { file: "ta-10.wav", sourceLang: "ta" },
  { file: "hi-09.wav", sourceLang: "hi" },
];

const CYCLES = 8;
const TOTAL_SCHEDULED = CLIPS.length * CYCLES; // 48

function parseWavDurationSec(buf) {
  let offset = 12;
  let fmt = null;
  let dataBytes = null;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === "fmt ") {
      fmt = {
        numChannels: buf.readUInt16LE(bodyStart + 2),
        sampleRate: buf.readUInt32LE(bodyStart + 4),
        bitsPerSample: buf.readUInt16LE(bodyStart + 14),
      };
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    }
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }
  const bytesPerSample = fmt.bitsPerSample / 8;
  return dataBytes / (fmt.sampleRate * fmt.numChannels * bytesPerSample);
}

function loadClip(path) {
  if (!existsSync(path)) {
    console.error(`Missing required audio file: ${path}`);
    process.exit(1);
  }
  const buf = readFileSync(path);
  const durationSec = parseWavDurationSec(buf);
  console.log(`Loaded ${path} (${buf.length} bytes, ${durationSec.toFixed(2)}s)`);
  return { buf, durationSec };
}

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Tukey's method: Q1/Q3 are the median of the lower/upper half, excluding
 * the overall median itself on an odd-length input. Returns nulls if empty. */
function quartiles(nums) {
  if (!nums.length) return { q1: null, q3: null };
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted.slice(0, mid);
  const upper = sorted.length % 2 === 0 ? sorted.slice(mid) : sorted.slice(mid + 1);
  return { q1: median(lower), q3: median(upper) };
}

function padCell(value, width) {
  const s = String(value ?? "");
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function printTable(rows, cols) {
  const widths = cols.map((c) => c.width);
  for (const row of rows) {
    cols.forEach((c, i) => {
      widths[i] = Math.max(widths[i], String(row[c.key] ?? "").length);
    });
  }
  console.log(cols.map((c, i) => padCell(c.label, widths[i])).join("  "));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(cols.map((c, i) => padCell(row[c.key], widths[i])).join("  "));
  }
}

/** Fisher-Yates. Returns a NEW shuffled array; does not mutate the input. */
function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * One POST /api/translate for one clip. roundTripMs is measured from just
 * before fetch() to the response JSON being fully parsed — same convention as
 * translate-gap-probe.mjs and translate-route-probe.mjs. `debug` (including
 * `providerTrace`) and `usage` are returned verbatim from the JSON body.
 */
async function translateRequest(clip) {
  const url = `${BASE_URL}/api/translate`;

  const fd = new FormData();
  fd.append("audio", new Blob([clip.buf], { type: "audio/wav" }), clip.file);
  fd.append("sourceLang", clip.sourceLang);
  // No `pipeline`/`model` field — let the route apply DEFAULT_PIPELINE.

  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, { method: "POST", body: fd });
  } catch (err) {
    return {
      ok: false,
      status: null,
      networkError: String(err?.message ?? err),
      roundTripMs: performance.now() - t0,
    };
  }

  if (res.status !== 200) {
    const bodyText = await res.text();
    let bodyJson = null;
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      // Not JSON — bodyText carries the raw response instead.
    }
    return {
      ok: false,
      status: res.status,
      bodyJson,
      bodyText,
      roundTripMs: performance.now() - t0,
    };
  }

  const json = await res.json();
  const roundTripMs = performance.now() - t0;
  return {
    ok: true,
    status: res.status,
    roundTripMs,
    debug: json.debug ?? null,
    usage: json.usage ?? null,
    translation: json.translation ?? null,
  };
}

function extractRow(entry) {
  const r = entry.result;
  const d = r.debug ?? {};
  const pt = d.providerTrace ?? {};
  return {
    cycle: entry.cycle,
    clip: entry.file,
    durationSec: entry.durationSec.toFixed(2),
    status: r.status ?? "ERR",
    roundTripMs: typeof r.roundTripMs === "number" ? r.roundTripMs.toFixed(1) : "-",
    requestToCompleteMs: typeof d.requestToCompleteMs === "number" ? d.requestToCompleteMs : "-",
    fetchToHeadersMs: typeof pt.fetchToHeadersMs === "number" ? pt.fetchToHeadersMs : "-",
    audioTokens: r.usage && typeof r.usage.audioTokens === "number" ? r.usage.audioTokens : "-",
    completionTokens:
      r.usage && typeof r.usage.completionTokens === "number" ? r.usage.completionTokens : "-",
    callIndexInProcess: typeof pt.callIndexInProcess === "number" ? pt.callIndexInProcess : "-",
    coldStart: typeof d.coldStart === "boolean" ? String(d.coldStart) : "-",
  };
}

async function main() {
  console.log(`Base URL: ${BASE_URL}`);
  console.log(
    `Total requests: 1 warm-up + ${TOTAL_SCHEDULED} scheduled (${CYCLES} cycles x ${CLIPS.length} clips), zero gap throughout.`,
  );
  console.log("Estimated runtime: roughly four minutes.");

  // Encode all six clips once, before any request.
  const loaded = new Map();
  for (const c of CLIPS) {
    loaded.set(c.file, { ...c, ...loadClip(join(CLIP_DIR, c.file)) });
  }

  const entries = [];

  // --- Warm-up: reported, excluded from all summary statistics below. ---
  console.log("\n=== Warm-up request (excluded from summary stats) ===\n");
  const warmupClip = loaded.get(CLIPS[0].file);
  const warmupResult = await translateRequest(warmupClip);
  entries.push({
    label: "warmup",
    cycle: 0,
    file: warmupClip.file,
    sourceLang: warmupClip.sourceLang,
    durationSec: warmupClip.durationSec,
    result: warmupResult,
  });
  console.log(
    `warm-up (${warmupClip.file}): status=${warmupResult.status ?? "ERR"}  roundTripMs=${
      typeof warmupResult.roundTripMs === "number" ? warmupResult.roundTripMs.toFixed(1) : "-"
    }`,
  );

  // --- Main schedule: 4 cycles of all 6 clips, zero gap, order randomised
  // within each cycle (printed) so drift across the run isn't confounded
  // with a clip's fixed position in the cycle. ---
  let remaining = TOTAL_SCHEDULED;
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const order = shuffle(CLIPS.map((c) => c.file));
    console.log(`\ncycle ${cycle} order: ${order.join(", ")}`);

    for (const file of order) {
      const clip = loaded.get(file);
      const result = await translateRequest(clip);
      entries.push({
        label: `c${cycle}-${file}`,
        cycle,
        file: clip.file,
        sourceLang: clip.sourceLang,
        durationSec: clip.durationSec,
        result,
      });
      remaining--;

      console.log(
        `[${entries.length - 1}/${TOTAL_SCHEDULED}] cycle ${cycle} clip=${file} ` +
          `status=${result.status ?? "ERR"} (${remaining} remaining)`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Output part 1: table in execution order (warm-up included as row 0).
  // ---------------------------------------------------------------------
  console.log("\n=== Table (execution order) ===\n");
  const rows = entries.map(extractRow);
  printTable(rows, [
    { key: "cycle", label: "cycle", width: 5 },
    { key: "clip", label: "clip", width: 12 },
    { key: "durationSec", label: "durationSec", width: 11 },
    { key: "status", label: "status", width: 6 },
    { key: "roundTripMs", label: "roundTripMs", width: 11 },
    { key: "requestToCompleteMs", label: "requestToCompleteMs", width: 19 },
    { key: "fetchToHeadersMs", label: "fetchToHeadersMs", width: 16 },
    { key: "audioTokens", label: "audioTokens", width: 11 },
    { key: "completionTokens", label: "completionTokens", width: 16 },
    { key: "callIndexInProcess", label: "callIndexInProcess", width: 18 },
    { key: "coldStart", label: "coldStart", width: 9 },
  ]);

  // ---------------------------------------------------------------------
  // Output part 2: summary. Warm-up excluded from every statistic below —
  // only the 24 scheduled requests count.
  // ---------------------------------------------------------------------
  const scheduled = entries.slice(1);
  const successful = scheduled.filter((e) => e.result.ok);
  const failed = scheduled.filter((e) => !e.result.ok);

  console.log("\n=== Summary ===\n");

  console.log("requestToCompleteMs by clip (min / median / max, n):");
  for (const c of CLIPS) {
    const vals = successful
      .filter((e) => e.file === c.file)
      .map((e) => e.result.debug?.requestToCompleteMs)
      .filter((v) => typeof v === "number");
    if (vals.length === 0) {
      console.log(`  ${c.file}: no successful samples`);
      continue;
    }
    console.log(
      `  ${c.file}: min=${Math.min(...vals)}  median=${median(vals)}  max=${Math.max(...vals)}  (n=${vals.length})`,
    );
    const { q1, q3 } = quartiles(vals);
    console.log(`    n=${vals.length}  IQR(requestToCompleteMs)=${q3 - q1}  [Q1=${q1}, Q3=${q3}]`);
  }

  console.log(
    "\nPer-clip median requestToCompleteMs vs audioTokens vs completionTokens " +
      "(sorted by completionTokens ascending):",
  );
  const perClip = CLIPS.map((c) => {
    const clipSuccessful = successful.filter((e) => e.file === c.file);
    const rtcVals = clipSuccessful
      .map((e) => e.result.debug?.requestToCompleteMs)
      .filter((v) => typeof v === "number");
    const audioTokVals = clipSuccessful
      .map((e) => e.result.usage?.audioTokens)
      .filter((v) => typeof v === "number");
    const compTokVals = clipSuccessful
      .map((e) => e.result.usage?.completionTokens)
      .filter((v) => typeof v === "number");
    return {
      file: c.file,
      medianRequestToCompleteMs: median(rtcVals),
      audioTokens: audioTokVals.length ? [...new Set(audioTokVals)] : [],
      completionTokens: compTokVals.length ? [...new Set(compTokVals)] : [],
      sortKey: compTokVals.length ? median(compTokVals) : Infinity,
    };
  }).sort((a, b) => a.sortKey - b.sortKey);
  for (const p of perClip) {
    console.log(
      `  ${p.file}: medianRequestToCompleteMs=${p.medianRequestToCompleteMs ?? "-"}  ` +
        `audioTokens=${JSON.stringify(p.audioTokens)}  completionTokens=${JSON.stringify(p.completionTokens)}`,
    );
  }

  console.log("\nDistinct translation strings per clip:");
  for (const c of CLIPS) {
    const translations = successful
      .filter((e) => e.file === c.file)
      .map((e) => e.result.translation)
      .filter((t) => typeof t === "string");
    const distinct = [...new Set(translations)];
    console.log(`  ${c.file}: ${distinct.length} distinct (n=${translations.length} successful)`);
    if (distinct.length > 1) {
      distinct.forEach((t, i) => console.log(`    [${i}] ${JSON.stringify(t)}`));
    }
  }

  console.log("\nDistinct completionTokens values per clip:");
  for (const c of CLIPS) {
    const vals = successful
      .filter((e) => e.file === c.file)
      .map((e) => e.result.usage?.completionTokens)
      .filter((v) => typeof v === "number");
    console.log(`  ${c.file}: ${JSON.stringify([...new Set(vals)])}`);
  }

  console.log("\ncallIndexInProcess (execution order, successful requests only):");
  const callIndexSeq = successful
    .map((e) => ({ label: e.label, value: e.result.debug?.providerTrace?.callIndexInProcess }))
    .filter((x) => typeof x.value === "number");
  let monotonic = true;
  const resets = [];
  for (let i = 1; i < callIndexSeq.length; i++) {
    if (callIndexSeq[i].value <= callIndexSeq[i - 1].value) {
      monotonic = false;
    }
    if (callIndexSeq[i].value === 1) {
      resets.push(callIndexSeq[i].label);
    }
  }
  console.log(`  sequence: ${callIndexSeq.map((x) => `${x.label}=${x.value}`).join(", ")}`);
  console.log(`  monotonically increasing across the whole run: ${monotonic}`);
  console.log(
    `  resets to 1 (new instance) at: ${resets.length ? resets.join(", ") : "none after the first request"}`,
  );

  console.log(`\nNon-200 or failed requests: ${failed.length} / ${scheduled.length}`);

  // ---------------------------------------------------------------------
  // Output part 3: complete per-request dataset, unrounded, as one JSON block.
  // ---------------------------------------------------------------------
  console.log("\n=== Full dataset (JSON) ===\n");
  console.log(
    JSON.stringify(
      entries.map((e) => ({
        label: e.label,
        cycle: e.cycle,
        clip: e.file,
        sourceLang: e.sourceLang,
        durationSec: e.durationSec,
        ok: e.result.ok,
        status: e.result.status,
        roundTripMs: e.result.roundTripMs,
        networkError: e.result.networkError ?? null,
        bodyText: e.result.ok ? undefined : e.result.bodyText,
        debug: e.result.debug ?? null,
        usage: e.result.usage ?? null,
        translation: e.result.translation ?? null,
      })),
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
