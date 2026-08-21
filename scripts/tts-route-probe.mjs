// Exercises the DEPLOYED /api/tts route (not the ElevenLabs API directly) and
// separates the Chennai->Vercel leg from the Vercel->ElevenLabs leg by
// measuring what a real client observes: ttfa/total against the Next.js
// route, not against the provider. No dependencies — Node built-ins and
// global fetch only.
//
//   node scripts/tts-route-probe.mjs
//
// No API key needed here — the deployed route holds ELEVENLABS_API_KEY
// server-side; this script only ever talks to our own /api/tts.

const BASE_URL = process.env.PROBE_BASE_URL || "https://lingobridge-tamil-hindi-translator.vercel.app";

// Ordinary conversational text, not shop/tailoring content. ~30 characters
// each, matching the "short" texts used in the ElevenLabs-direct probes.
const TA_SHORT = "நாளைக்கு அம்மாகிட்ட போய் வரேன்.";
const HI_SHORT = "कल शाम मम्मी से मिलने जाऊँगा।";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let totalRequests = 0;
let non200Count = 0;

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
 * One POST /api/tts. Streams the body via the reader (never arrayBuffer())
 * so ttfaMs measures the real first-chunk arrival, not a buffered read.
 * Audio bytes themselves are discarded — we're measuring timing, not
 * listening, so nothing is written to disk.
 */
async function ttsRequest(body) {
  totalRequests++;
  const url = `${BASE_URL}/api/tts`;
  const t0 = performance.now();

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
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

  const contentType = res.headers.get("Content-Type");
  const audioFormat = res.headers.get("X-Audio-Format");

  let ttfaMs = null;
  let bytes = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      if (ttfaMs === null) ttfaMs = performance.now() - t0;
      bytes += value.length;
    }
  }
  const totalMs = performance.now() - t0;

  return { ok: true, status: res.status, ttfaMs, totalMs, bytes, contentType, audioFormat };
}

function printFailure(label, r) {
  if (r.networkError) {
    console.log(`${label}: request failed — ${r.networkError}`);
    return;
  }
  console.log(`${label}: HTTP ${r.status}`);
  console.log(r.bodyJson !== null ? JSON.stringify(r.bodyJson, null, 2) : r.bodyText);
}

function printSingleResult(label, r) {
  if (!r.ok) {
    printFailure(label, r);
    return;
  }
  console.log(
    `${label}: status=${r.status}  ttfaMs=${r.ttfaMs === null ? "-" : r.ttfaMs.toFixed(1)}  ` +
      `totalMs=${r.totalMs.toFixed(1)}  bytes=${r.bytes}  ` +
      `contentType=${r.contentType}  audioFormat=${r.audioFormat}`,
  );
}

async function countdown(seconds, label) {
  for (let s = seconds; s > 0; s--) {
    process.stdout.write(`\r${label}: ${String(s).padStart(2, " ")}s remaining...   `);
    await sleep(1000);
  }
  process.stdout.write(`\r${label}: done.                          \n`);
}

// ---------------------------------------------------------------------------
async function part1Cold() {
  console.log("\n=== Part 1 — cold path (first call this run) ===\n");
  const r = await ttsRequest({ text: TA_SHORT, targetLang: "ta" });
  if (!r.ok) {
    printFailure("cold ta", r);
    return;
  }
  printSingleResult("cold ta (first request)", r);
}

// ---------------------------------------------------------------------------
async function part2Warm() {
  console.log(
    "\n=== Part 2 — warm path (5x ta/female, 5x hi/male, back-to-back) ===\n",
  );

  const rows = [];
  const medianInput = { ta: { ttfa: [], total: [] }, hi: { ttfa: [], total: [] } };
  // ta/female + hi/male here; part3IdleRecovery covers ta/male + hi/female —
  // between the two, all four VOICE_IDS table entries get exercised.
  const voiceGenderByLang = { ta: "female", hi: "male" };

  for (const lang of ["ta", "hi"]) {
    const text = lang === "ta" ? TA_SHORT : HI_SHORT;
    const voiceGender = voiceGenderByLang[lang];
    for (let run = 1; run <= 5; run++) {
      const r = await ttsRequest({ text, targetLang: lang, voiceGender });
      if (!r.ok) {
        printFailure(`${lang} run${run}`, r);
        rows.push({ lang, run, status: r.status ?? "ERR", ttfaMs: "-", totalMs: "-", bytes: "-" });
        continue;
      }
      rows.push({
        lang,
        run,
        status: r.status,
        ttfaMs: r.ttfaMs === null ? "-" : r.ttfaMs.toFixed(1),
        totalMs: r.totalMs.toFixed(1),
        bytes: r.bytes,
      });
      if (r.ttfaMs !== null) medianInput[lang].ttfa.push(r.ttfaMs);
      medianInput[lang].total.push(r.totalMs);
    }
  }

  console.log("");
  printTable(rows, [
    { key: "lang", label: "lang", width: 4 },
    { key: "run", label: "run", width: 3 },
    { key: "status", label: "status", width: 6 },
    { key: "ttfaMs", label: "ttfaMs", width: 8 },
    { key: "totalMs", label: "totalMs", width: 8 },
    { key: "bytes", label: "bytes", width: 8 },
  ]);

  console.log("\nPer-language medians:");
  for (const lang of ["ta", "hi"]) {
    const medTtfa = median(medianInput[lang].ttfa);
    const medTotal = median(medianInput[lang].total);
    console.log(
      `  ${lang}: ttfaMs=${medTtfa === null ? "-" : medTtfa.toFixed(1)}  ` +
        `totalMs=${medTotal === null ? "-" : medTotal.toFixed(1)}  (n=${medianInput[lang].total.length}/5 ok)`,
    );
  }
}

// ---------------------------------------------------------------------------
async function part3IdleRecovery() {
  console.log(
    "\n=== Part 3 — idle recovery (60s wait, then one ta/male + one hi/female request) ===\n",
  );
  await countdown(60, "Waiting before post-idle requests");

  // Opposite genders from Part 2 (ta/female, hi/male), so the other two
  // VOICE_IDS table entries get exercised across the run.
  const rTa = await ttsRequest({ text: TA_SHORT, targetLang: "ta", voiceGender: "male" });
  printSingleResult("post-idle ta", rTa);
  const rHi = await ttsRequest({ text: HI_SHORT, targetLang: "hi", voiceGender: "female" });
  printSingleResult("post-idle hi", rHi);
}

// ---------------------------------------------------------------------------
async function part4Validation() {
  console.log("\n=== Part 4 — validation ===\n");

  const cases = [
    { label: "whitespace-only text", body: { text: " ", targetLang: "ta" }, expectedStatus: 400 },
    { label: "invalid targetLang ('en')", body: { text: "test", targetLang: "en" }, expectedStatus: 400 },
    { label: "missing text", body: { targetLang: "ta" }, expectedStatus: 400 },
    {
      label: "invalid voiceGender ('other')",
      body: { text: "test", targetLang: "ta", voiceGender: "other" },
      expectedStatus: 400,
    },
    {
      label: "missing voiceGender (TODO(5) default to female)",
      body: { text: TA_SHORT, targetLang: "ta" },
      expectedStatus: 200,
    },
  ];

  for (const { label, body, expectedStatus } of cases) {
    const r = await ttsRequest(body);
    const actualStatus = r.ok ? r.status : r.status ?? "ERR";
    if (actualStatus !== expectedStatus) {
      console.log(`${label}: UNEXPECTED status=${actualStatus} (expected ${expectedStatus})`);
      if (!r.ok) printFailure(label, r);
      continue;
    }
    if (r.ok) {
      printSingleResult(label, r);
    } else {
      printFailure(label, r);
    }
  }
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`Base URL: ${BASE_URL}`);

  await part1Cold();
  await part2Warm();
  await part3IdleRecovery();
  await part4Validation();

  console.log("\n=== Summary ===");
  console.log(`Total requests: ${totalRequests}`);
  console.log(`Non-200 responses: ${non200Count}`);
  console.log(
    "Note: every ttfaMs/totalMs above includes the Chennai->Vercel leg (this " +
      "machine to the deployed function), not just Vercel->ElevenLabs. The " +
      "server-side marks (providerHeadersMs, providerFirstAudioByteMs, cold " +
      "start, execRegion) are NOT in this output — they're logged inside the " +
      "route (app/api/tts/route.ts) and must be read from the Vercel function " +
      "logs for these same requests.",
  );
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
