// Exercises the DEPLOYED /api/translate route to test whether IDLE TIME before
// a request predicts translate-leg latency — not just cold-start-vs-warm, but
// a possible gradient across the gap length itself.
//
// scripts/translate-route-probe.mjs fires its warm-path requests back-to-back
// (gap pinned at zero), so it cannot see this. This probe holds the clip and
// sourceLang constant and varies only the gap before each request, so any
// spread in requestToCompleteMs on identical input is attributable to the gap,
// not to different audio or a different translation workload.
//
// `temperature: 0` (already locked in lib/translate/gemini-direct.ts) is the
// control here: identical input should return identical text and an identical
// completion-token count on every call. If it doesn't, some of the observed
// spread is inference variance, not gap effect — the summary reports on this
// directly (distinct translation strings, distinct completionTokens values).
//
//   node scripts/translate-gap-probe.mjs
//
// No dependencies — Node built-ins and global fetch only. No API key needed:
// the deployed route holds GEMINI_API_KEY/OPENROUTER_API_KEY server-side; this
// script only ever talks to our own /api/translate. Mirrors
// scripts/translate-route-probe.mjs's structure/output/labelling so the two
// probes are directly comparable — that file is left untouched.

import { readFileSync, existsSync } from "node:fs";

const BASE_URL = process.env.PROBE_BASE_URL || "https://lingobridge-tamil-hindi-translator.vercel.app";

// One clip only, held constant across every request so the gap is the only
// thing that varies. hi-11.wav, 3.37s (docs/PLAN.md / earlier duration probe) —
// read and base64-encoded once, outside the request loop, so encoding never
// lands inside a measured interval.
const CLIP_PATH = "test-clips/hi-11.wav";
const CLIP_FILENAME = "hi-11.wav";
const SOURCE_LANG = "hi";

// Gaps under test, seconds. Interleaved as 5 repeating cycles of this exact
// order — NOT blocked by gap — so a warming/aging trend across the ~11-minute
// run can't be mistaken for a gap effect.
const GAPS_SEC = [0, 5, 15, 30, 60];
const CYCLES = 5;
const TOTAL_SCHEDULED = GAPS_SEC.length * CYCLES; // 25

function loadClip(path) {
  if (!existsSync(path)) {
    console.error(`Missing required audio file: ${path}`);
    process.exit(1);
  }
  const buf = readFileSync(path);
  console.log(`Loaded ${path} (${buf.length} bytes)`);
  return buf;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
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

/**
 * One POST /api/translate against the fixed clip. roundTripMs is measured
 * from just before fetch() to the response JSON being fully parsed — a single
 * client-clock duration, same convention as translate-route-probe.mjs.
 * `debug` (including `providerTrace`) and `usage` are returned verbatim from
 * the JSON body; nothing here recomputes or rounds them further.
 */
async function translateRequest(audioBuf, filename) {
  const url = `${BASE_URL}/api/translate`;

  const fd = new FormData();
  fd.append("audio", new Blob([audioBuf], { type: "audio/wav" }), filename);
  fd.append("sourceLang", SOURCE_LANG);
  // No `pipeline`/`model` field — let the route apply DEFAULT_PIPELINE, same
  // as translate-route-probe.mjs.

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
    label: entry.label,
    cycle: entry.cycle,
    nominalGap: entry.nominalGap === null ? "-" : entry.nominalGap,
    measuredGap: entry.measuredGapSec === null ? "-" : entry.measuredGapSec.toFixed(2),
    status: r.status ?? "ERR",
    roundTripMs: typeof r.roundTripMs === "number" ? r.roundTripMs.toFixed(1) : "-",
    requestToCompleteMs: typeof d.requestToCompleteMs === "number" ? d.requestToCompleteMs : "-",
    fetchToHeadersMs: typeof pt.fetchToHeadersMs === "number" ? pt.fetchToHeadersMs : "-",
    callIndexInProcess: typeof pt.callIndexInProcess === "number" ? pt.callIndexInProcess : "-",
    coldStart: typeof d.coldStart === "boolean" ? String(d.coldStart) : "-",
    serviceTier: pt.serviceTier ?? "-",
    completionTokens:
      r.usage && typeof r.usage.completionTokens === "number" ? r.usage.completionTokens : "-",
  };
}

async function main() {
  console.log(`Base URL: ${BASE_URL}`);
  console.log(
    "Total runtime: about eleven minutes " +
      `(1 warm-up + ${CYCLES} cycles x gaps [${GAPS_SEC.join(", ")}]s + request time each).`,
  );

  const clipBuf = loadClip(CLIP_PATH);

  const entries = [];
  let remaining = TOTAL_SCHEDULED;

  // --- Warm-up: reported, excluded from all summary statistics below. ---
  console.log("\n=== Warm-up request (excluded from summary stats) ===\n");
  const warmupResult = await translateRequest(clipBuf, CLIP_FILENAME);
  const warmupEntry = {
    label: "warmup",
    cycle: 0,
    nominalGap: null,
    measuredGapSec: null,
    result: warmupResult,
  };
  entries.push(warmupEntry);
  console.log(
    `warm-up: status=${warmupResult.status ?? "ERR"}  roundTripMs=${
      typeof warmupResult.roundTripMs === "number" ? warmupResult.roundTripMs.toFixed(1) : "-"
    }`,
  );

  // lastResponseCompleteAt anchors the MEASURED gap: wall time from the
  // previous response completing to the next request being sent. Set right
  // after each attempt resolves (success, non-200, or network failure alike).
  let lastResponseCompleteAt = performance.now();

  // --- Main schedule: 5 cycles x [0,5,15,30,60]s, interleaved, not blocked. ---
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    for (const nominalGap of GAPS_SEC) {
      await sleep(nominalGap * 1000);

      const sendMark = performance.now();
      const measuredGapSec = (sendMark - lastResponseCompleteAt) / 1000;

      const result = await translateRequest(clipBuf, CLIP_FILENAME);
      lastResponseCompleteAt = performance.now();

      const entry = {
        label: `c${cycle}-g${nominalGap}`,
        cycle,
        nominalGap,
        measuredGapSec,
        result,
      };
      entries.push(entry);
      remaining--;

      console.log(
        `[${entries.length - 1}/${TOTAL_SCHEDULED}] cycle ${cycle} nominalGap=${nominalGap}s ` +
          `measuredGap=${measuredGapSec.toFixed(2)}s status=${result.status ?? "ERR"} ` +
          `(${remaining} remaining)`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Output part 1: table in execution order (warm-up included as row 0).
  // ---------------------------------------------------------------------
  console.log("\n=== Table (execution order) ===\n");
  const rows = entries.map(extractRow);
  printTable(rows, [
    { key: "label", label: "label", width: 8 },
    { key: "cycle", label: "cycle", width: 5 },
    { key: "nominalGap", label: "nominalGap", width: 10 },
    { key: "measuredGap", label: "measuredGap", width: 11 },
    { key: "status", label: "status", width: 6 },
    { key: "roundTripMs", label: "roundTripMs", width: 11 },
    { key: "requestToCompleteMs", label: "requestToCompleteMs", width: 19 },
    { key: "fetchToHeadersMs", label: "fetchToHeadersMs", width: 16 },
    { key: "callIndexInProcess", label: "callIndexInProcess", width: 18 },
    { key: "coldStart", label: "coldStart", width: 9 },
    { key: "serviceTier", label: "serviceTier", width: 11 },
    { key: "completionTokens", label: "completionTokens", width: 16 },
  ]);

  // ---------------------------------------------------------------------
  // Output part 2: summary. Warm-up excluded from every statistic below —
  // only the 25 scheduled requests count.
  // ---------------------------------------------------------------------
  const scheduled = entries.slice(1);
  const successful = scheduled.filter((e) => e.result.ok);
  const failed = scheduled.filter((e) => !e.result.ok);

  console.log("\n=== Summary ===\n");

  console.log("requestToCompleteMs by nominal gap (min / median / max, n):");
  for (const gap of GAPS_SEC) {
    const vals = successful
      .filter((e) => e.nominalGap === gap)
      .map((e) => e.result.debug?.requestToCompleteMs)
      .filter((v) => typeof v === "number");
    if (vals.length === 0) {
      console.log(`  gap=${gap}s: no successful samples`);
      continue;
    }
    console.log(
      `  gap=${gap}s: min=${Math.min(...vals)}  median=${median(vals)}  max=${Math.max(...vals)}  (n=${vals.length})`,
    );
  }

  console.log("\nrequestToCompleteMs by coldStart (min / median / max, n):");
  for (const cs of [true, false]) {
    const vals = successful
      .filter((e) => e.result.debug?.coldStart === cs)
      .map((e) => e.result.debug?.requestToCompleteMs)
      .filter((v) => typeof v === "number");
    if (vals.length === 0) {
      console.log(`  coldStart=${cs}: no successful samples`);
      continue;
    }
    console.log(
      `  coldStart=${cs}: min=${Math.min(...vals)}  median=${median(vals)}  max=${Math.max(...vals)}  (n=${vals.length})`,
    );
  }

  const translations = successful.map((e) => e.result.translation).filter((t) => typeof t === "string");
  const distinctTranslations = [...new Set(translations)];
  console.log(`\nDistinct translation strings across successful requests: ${distinctTranslations.length}`);
  if (distinctTranslations.length > 1) {
    distinctTranslations.forEach((t, i) => console.log(`  [${i}] ${JSON.stringify(t)}`));
  }

  const completionTokensValues = successful
    .map((e) => e.result.usage?.completionTokens)
    .filter((v) => typeof v === "number");
  const distinctCompletionTokens = [...new Set(completionTokensValues)];
  console.log(`\nDistinct completionTokens values: ${JSON.stringify(distinctCompletionTokens)}`);

  const serviceTierValues = successful
    .map((e) => e.result.debug?.providerTrace?.serviceTier)
    .filter((v) => v !== undefined);
  const distinctServiceTiers = [...new Set(serviceTierValues)];
  console.log(`Distinct serviceTier values: ${JSON.stringify(distinctServiceTiers)}`);

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

  const traceResidualValues = successful
    .map((e) => e.result.debug?.providerTrace?.traceResidualMs)
    .filter((v) => typeof v === "number");
  if (traceResidualValues.length) {
    console.log(
      `\ntraceResidualMs range: min=${Math.min(...traceResidualValues)}  max=${Math.max(...traceResidualValues)}  (n=${traceResidualValues.length})`,
    );
  } else {
    console.log("\ntraceResidualMs range: no successful samples with a providerTrace");
  }

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
        nominalGapSec: e.nominalGap,
        measuredGapSec: e.measuredGapSec,
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
