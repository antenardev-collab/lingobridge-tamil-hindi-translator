// Exercises the DEPLOYED /api/translate route to test whether latency stays
// flat as input duration extends well past what the corpus previously
// covered.
//
// scripts/translate-length-probe.mjs found no latency effect across
// 1.92-5.97s of audio — but that was the entire range the 26-clip corpus
// contained. Real conversational turns run 20-30 seconds. This probe extends
// the input axis roughly fivefold, to 30.59s, to test whether the flat line
// holds or breaks. Tamil only, so source language is held constant — the
// finding this produces reads "Tamil→Hindi, verified to 30s", not as a
// general claim across both directions.
//
// tamil15s-16k.wav and tamil30s-16k.wav were resampled from 48kHz originals
// (tamil15s.wav, tamil30s.wav) with a 31-tap windowed-sinc FIR (Hamming
// window, 8000 Hz cutoff) and 3:1 decimation, matching the corpus's
// 16000 Hz/mono/16-bit format so the comparison to ta-10/ta-12 is valid.
// test-clips/*.wav is gitignored — all four clips here, and the two 48kHz
// sources they came from, are local-only and will not appear in `git status`.
//
// scripts/translate-gap-probe.mjs proved serving variance exists even at
// fixed input, so per-clip spread (IQR) is reported alongside every median
// here, same as translate-length-probe.mjs — a single-run median is not
// trustworthy on its own.
//
//   node scripts/translate-longform-probe.mjs
//
// No dependencies — Node built-ins and global fetch only. No API key needed:
// the deployed route holds GEMINI_API_KEY/OPENROUTER_API_KEY server-side; this
// script only ever talks to our own /api/translate. Mirrors
// scripts/translate-length-probe.mjs's structure/output/labelling; that file
// and every other existing probe are left untouched.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.env.PROBE_BASE_URL || "https://lingobridge-tamil-hindi-translator.vercel.app";

const CLIP_DIR = "test-clips";

/**
 * Four clips, hardcoded, all Tamil, all 16000 Hz:
 *   - tamil30s-16k.wav (30.59s): the long-form anchor.
 *   - tamil15s-16k.wav (15.81s): the midpoint, so a break in the line can be
 *     located rather than merely detected.
 *   - ta-10.wav (5.46s): the longest clip in the length probe. The join
 *     between the two runs — its median should reproduce ~990ms here if
 *     conditions are comparable.
 *   - ta-12.wav (1.92s): the short anchor.
 */
const CLIPS = [
  { file: "tamil30s-16k.wav", sourceLang: "ta" },
  { file: "tamil15s-16k.wav", sourceLang: "ta" },
  { file: "ta-10.wav", sourceLang: "ta" },
  { file: "ta-12.wav", sourceLang: "ta" },
];

const CYCLES = 8;
const TOTAL_SCHEDULED = CLIPS.length * CYCLES; // 32

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
 * translate-length-probe.mjs. For the 30s/15s clips this is dominated by
 * upload time (see the startup note) and is not comparable across clips;
 * requestToCompleteMs (server clock, from `debug`) is the figure that matters
 * here. `debug` (including `providerTrace`) and `usage` are returned verbatim
 * from the JSON body.
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
    requestBytes: typeof pt.requestBytes === "number" ? pt.requestBytes : "-",
    audioTokens: r.usage && typeof r.usage.audioTokens === "number" ? r.usage.audioTokens : "-",
    completionTokens:
      r.usage && typeof r.usage.completionTokens === "number" ? r.usage.completionTokens : "-",
    finishReason: pt.finishReason ?? "-",
    callIndexInProcess: typeof pt.callIndexInProcess === "number" ? pt.callIndexInProcess : "-",
    coldStart: typeof d.coldStart === "boolean" ? String(d.coldStart) : "-",
  };
}

async function main() {
  console.log(`Base URL: ${BASE_URL}`);
  console.log(
    `Total requests: 1 warm-up + ${TOTAL_SCHEDULED} scheduled (${CYCLES} cycles x ${CLIPS.length} clips), zero gap throughout.`,
  );
  console.log(
    "Estimated runtime: roughly five minutes — the 30s/15s clips' upload and " +
      "processing time dominate over translate-length-probe.mjs's per-request cost.",
  );
  console.log(
    "Note: the 30s clip carries a ~1.3MB request payload, so roundTripMs for it " +
      "will be dominated by upload and is NOT comparable to the shorter clips. " +
      "requestToCompleteMs (server clock) is the figure that matters here.",
  );

  // Encode all four clips once, before any request.
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

  // --- Main schedule: 8 cycles of all 4 clips, zero gap, order randomised
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
    { key: "clip", label: "clip", width: 18 },
    { key: "durationSec", label: "durationSec", width: 11 },
    { key: "status", label: "status", width: 6 },
    { key: "roundTripMs", label: "roundTripMs", width: 11 },
    { key: "requestToCompleteMs", label: "requestToCompleteMs", width: 19 },
    { key: "fetchToHeadersMs", label: "fetchToHeadersMs", width: 16 },
    { key: "requestBytes", label: "requestBytes", width: 12 },
    { key: "audioTokens", label: "audioTokens", width: 11 },
    { key: "completionTokens", label: "completionTokens", width: 16 },
    { key: "finishReason", label: "finishReason", width: 12 },
    { key: "callIndexInProcess", label: "callIndexInProcess", width: 18 },
    { key: "coldStart", label: "coldStart", width: 9 },
  ]);

  // ---------------------------------------------------------------------
  // Output part 2: summary. Warm-up excluded from every statistic below —
  // only the 32 scheduled requests count.
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
    "\nPer-clip median requestToCompleteMs vs durationSec vs audioTokens vs completionTokens " +
      "(sorted by audioTokens ascending):",
  );
  const perClip = CLIPS.map((c) => {
    const clip = loaded.get(c.file);
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
      durationSec: clip.durationSec,
      medianRequestToCompleteMs: median(rtcVals),
      medianAudioTokens: median(audioTokVals),
      audioTokens: audioTokVals.length ? [...new Set(audioTokVals)] : [],
      completionTokens: compTokVals.length ? [...new Set(compTokVals)] : [],
      sortKey: audioTokVals.length ? median(audioTokVals) : Infinity,
    };
  }).sort((a, b) => a.sortKey - b.sortKey);
  for (const p of perClip) {
    console.log(
      `  ${p.file}: durationSec=${p.durationSec.toFixed(2)}  medianRequestToCompleteMs=${p.medianRequestToCompleteMs ?? "-"}  ` +
        `audioTokens=${JSON.stringify(p.audioTokens)}  completionTokens=${JSON.stringify(p.completionTokens)}`,
    );
  }

  console.log("\naudioTokens per second of duration (median audioTokens / durationSec), by clip:");
  for (const p of perClip) {
    const rate = p.medianAudioTokens === null ? null : p.medianAudioTokens / p.durationSec;
    console.log(
      `  ${p.file}: ${rate === null ? "no successful samples" : `${rate.toFixed(2)}/sec (medianAudioTokens=${p.medianAudioTokens}, durationSec=${p.durationSec.toFixed(2)})`}`,
    );
  }

  console.log("\nmedian requestToCompleteMs / audioTokens, by clip (flat vs proportional check):");
  for (const p of perClip) {
    const ratio =
      p.medianAudioTokens === null || p.medianRequestToCompleteMs === null
        ? null
        : p.medianRequestToCompleteMs / p.medianAudioTokens;
    console.log(
      `  ${p.file}: ${ratio === null ? "no successful samples" : `${ratio.toFixed(2)} ms/audioToken`}`,
    );
  }

  console.log("\nDistinct finishReason values (all successful requests, all clips):");
  const finishReasons = successful.map((e) => e.result.debug?.providerTrace?.finishReason ?? null);
  const finishReasonCounts = new Map();
  for (const fr of finishReasons) {
    finishReasonCounts.set(fr, (finishReasonCounts.get(fr) ?? 0) + 1);
  }
  for (const [fr, count] of finishReasonCounts) {
    const flag = fr !== "STOP" ? "  <-- NOT STOP, possible truncation" : "";
    console.log(`  ${JSON.stringify(fr)}: ${count}${flag}`);
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
      distinct.forEach((t, i) => console.log(`    [${i}] ${JSON.stringify(t.slice(0, 200))}`));
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
  for (const e of failed) {
    const r = e.result;
    if (r.networkError) {
      console.log(`  ${e.label}: network error — ${r.networkError}`);
      continue;
    }
    const snippet = (r.bodyText ?? "").slice(0, 300);
    console.log(`  ${e.label}: HTTP ${r.status ?? "ERR"} — ${snippet}`);
  }

  // ---------------------------------------------------------------------
  // Output part 3: complete per-request dataset as one JSON block.
  // translation is truncated to its first 200 characters here — the 30s
  // clip's output is long and this keeps the block pasteable/readable; the
  // full string is available by re-running a single request if needed.
  // ---------------------------------------------------------------------
  console.log("\n=== Full dataset (JSON, translation truncated to 200 chars) ===\n");
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
        translation:
          typeof e.result.translation === "string" ? e.result.translation.slice(0, 200) : e.result.translation ?? null,
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
