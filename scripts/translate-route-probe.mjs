// Exercises the DEPLOYED /api/translate route and reads back its own
// server-side latency decomposition (the `debug` object it returns in the
// JSON body — see app/api/translate/route.ts's buildDebug()), rather than
// only timing the client's view of the request. Mirrors
// scripts/tts-route-probe.mjs's structure/output/labelling so the two
// probes are directly comparable. No dependencies — Node built-ins and
// global fetch only.
//
//   node scripts/translate-route-probe.mjs
//
// No API key needed here — the deployed route holds GEMINI_API_KEY/
// OPENROUTER_API_KEY server-side; this script only ever talks to our own
// /api/translate.

import { readFileSync, existsSync } from "node:fs";

const BASE_URL = process.env.PROBE_BASE_URL || "https://lingobridge-tamil-hindi-translator.vercel.app";

// Loaded once at startup and reused for every request — file I/O never runs
// inside a timed section. Both are the shortest clip in their language
// (see docs/PLAN.md — ta-11/hi-11 are documented as a matched short-clip
// pair), so repeated requests stay cheap and comparable to the /api/tts
// probe's short-text choices.
const TA_CLIP_PATH = "test-clips/ta-11.wav";
const HI_CLIP_PATH = "test-clips/hi-11.wav";

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

let totalRequests = 0;
let non200Count = 0;
let coldStartTrueCount = 0;
const execRegionsSeen = new Set();

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
 * One POST /api/translate. roundTripMs is measured from just before fetch()
 * to the response JSON being fully parsed — a single client-clock duration.
 * `debug` (if present) is the server's own single-clock decomposition,
 * returned in the JSON body (not a header, not a log line — see
 * app/api/translate/route.ts). We never print json.original/json.translation:
 * this probe measures timing, not translation quality.
 */
async function translateRequest(sourceLang, audioBuf, filename) {
  totalRequests++;
  const url = `${BASE_URL}/api/translate`;

  const fd = new FormData();
  fd.append("audio", new Blob([audioBuf], { type: "audio/wav" }), filename);
  fd.append("sourceLang", sourceLang);
  // No `pipeline`/`model` field — let the route apply DEFAULT_PIPELINE.

  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, { method: "POST", body: fd });
  } catch (err) {
    non200Count++;
    return { ok: false, status: null, networkError: String(err?.message ?? err) };
  }

  if (res.status !== 200) {
    non200Count++;
    const bodyText = await res.text();
    let bodyJson = null;
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      // Not JSON — bodyText carries the raw response instead.
    }
    return { ok: false, status: res.status, bodyJson, bodyText };
  }

  const json = await res.json();
  const roundTripMs = performance.now() - t0;

  const debug = json.debug ?? {};
  if (debug.coldStart === true) coldStartTrueCount++;
  if (typeof debug.execRegion === "string") execRegionsSeen.add(debug.execRegion);
  else execRegionsSeen.add(String(debug.execRegion));

  // The ONLY cross-clock arithmetic this script permits: roundTripMs (a
  // single duration, entirely on the client's performance.now() clock) minus
  // serverTotalMs (a single duration, entirely on the server's
  // performance.now() clock). This is subtracting two same-clock TOTALS, not
  // spanning a mark across clocks — the same derivation ServerDebug's own
  // comment (lib/types.ts) sanctions for the client. Anything else (e.g. a
  // client mark minus a server mark) would NOT be valid.
  const transportMs =
    typeof debug.serverTotalMs === "number" ? roundTripMs - debug.serverTotalMs : null;

  return { ok: true, status: res.status, roundTripMs, debug, transportMs };
}

function printFailure(label, r) {
  if (r.networkError) {
    console.log(`${label}: request failed — ${r.networkError}`);
    return;
  }
  console.log(`${label}: HTTP ${r.status}`);
  console.log(r.bodyJson !== null ? JSON.stringify(r.bodyJson, null, 2) : r.bodyText);
}

function printFullResult(label, r) {
  if (!r.ok) {
    printFailure(label, r);
    return;
  }
  console.log(
    `${label}: status=${r.status}  roundTripMs=${r.roundTripMs.toFixed(1)}  ` +
      `transportMs=${r.transportMs === null ? "-" : r.transportMs.toFixed(1)}`,
  );
  console.log(`  debug: ${JSON.stringify(r.debug, null, 2).split("\n").join("\n  ")}`);
}

async function countdown(seconds, label) {
  for (let s = seconds; s > 0; s--) {
    process.stdout.write(`\r${label}: ${String(s).padStart(2, " ")}s remaining...   `);
    await sleep(1000);
  }
  process.stdout.write(`\r${label}: done.                          \n`);
}

// ---------------------------------------------------------------------------
async function part1Cold(taBuf) {
  console.log("\n=== Part 1 — cold path (first call this run) ===\n");
  const r = await translateRequest("ta", taBuf, "ta-11.wav");
  printFullResult("cold ta (first request)", r);
}

// ---------------------------------------------------------------------------
async function part2Warm(taBuf, hiBuf) {
  console.log("\n=== Part 2 — warm path (5x ta, 5x hi, back-to-back) ===\n");

  const rows = [];
  const medianInput = {
    ta: { roundTrip: [], serverTotal: [], transport: [] },
    hi: { roundTrip: [], serverTotal: [], transport: [] },
  };

  for (const lang of ["ta", "hi"]) {
    const buf = lang === "ta" ? taBuf : hiBuf;
    const filename = lang === "ta" ? "ta-11.wav" : "hi-11.wav";
    for (let run = 1; run <= 5; run++) {
      const r = await translateRequest(lang, buf, filename);
      if (!r.ok) {
        printFailure(`${lang} run${run}`, r);
        rows.push({
          lang,
          run,
          status: r.status ?? "ERR",
          roundTripMs: "-",
          serverTotalMs: "-",
          transportMs: "-",
          requestToCompleteMs: "-",
          coldStart: "-",
          execRegion: "-",
        });
        continue;
      }
      const d = r.debug;
      rows.push({
        lang,
        run,
        status: r.status,
        roundTripMs: r.roundTripMs.toFixed(1),
        serverTotalMs: typeof d.serverTotalMs === "number" ? d.serverTotalMs : "-",
        transportMs: r.transportMs === null ? "-" : r.transportMs.toFixed(1),
        requestToCompleteMs: typeof d.requestToCompleteMs === "number" ? d.requestToCompleteMs : "-",
        coldStart: String(d.coldStart),
        execRegion: String(d.execRegion),
      });
      medianInput[lang].roundTrip.push(r.roundTripMs);
      if (typeof d.serverTotalMs === "number") medianInput[lang].serverTotal.push(d.serverTotalMs);
      if (r.transportMs !== null) medianInput[lang].transport.push(r.transportMs);
    }
  }

  console.log("");
  printTable(rows, [
    { key: "lang", label: "lang", width: 4 },
    { key: "run", label: "run", width: 3 },
    { key: "status", label: "status", width: 6 },
    { key: "roundTripMs", label: "roundTripMs", width: 11 },
    { key: "serverTotalMs", label: "serverTotalMs", width: 13 },
    { key: "transportMs", label: "transportMs", width: 11 },
    { key: "requestToCompleteMs", label: "requestToCompleteMs", width: 19 },
    { key: "coldStart", label: "coldStart", width: 9 },
    { key: "execRegion", label: "execRegion", width: 10 },
  ]);

  console.log("\nPer-language medians:");
  for (const lang of ["ta", "hi"]) {
    const medRoundTrip = median(medianInput[lang].roundTrip);
    const medServerTotal = median(medianInput[lang].serverTotal);
    const medTransport = median(medianInput[lang].transport);
    console.log(
      `  ${lang}: roundTripMs=${medRoundTrip === null ? "-" : medRoundTrip.toFixed(1)}  ` +
        `serverTotalMs=${medServerTotal === null ? "-" : medServerTotal.toFixed(1)}  ` +
        `transportMs=${medTransport === null ? "-" : medTransport.toFixed(1)}  ` +
        `(n=${medianInput[lang].roundTrip.length}/5 ok)`,
    );
  }
}

// ---------------------------------------------------------------------------
async function part3IdleRecovery(taBuf, hiBuf) {
  console.log("\n=== Part 3 — idle recovery (60s wait, then one request per language) ===\n");
  await countdown(60, "Waiting before post-idle requests");

  const rTa = await translateRequest("ta", taBuf, "ta-11.wav");
  printFullResult("post-idle ta", rTa);
  const rHi = await translateRequest("hi", hiBuf, "hi-11.wav");
  printFullResult("post-idle hi", rHi);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`Base URL: ${BASE_URL}`);

  const taBuf = loadClip(TA_CLIP_PATH);
  const hiBuf = loadClip(HI_CLIP_PATH);

  await part1Cold(taBuf);
  await part2Warm(taBuf, hiBuf);
  await part3IdleRecovery(taBuf, hiBuf);

  console.log("\n=== Summary ===");
  console.log(`Total requests: ${totalRequests}`);
  console.log(`Non-200 responses: ${non200Count}`);
  console.log(`Responses with coldStart=true: ${coldStartTrueCount}`);
  console.log(`Distinct execRegion values seen: ${[...execRegionsSeen].join(", ")}`);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
