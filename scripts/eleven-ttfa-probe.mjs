// ElevenLabs streaming-TTS probe: latency (TTFA + total), byte-output
// nondeterminism across identical requests, PCM output on library voices,
// and a set of "script-boundary" inputs (abbreviations, digit/letter splits,
// repeated requests, time-of-day notation) that are known trouble spots for
// TTS number/abbreviation reading. No dependencies — Node built-ins and
// global fetch only.
//
//   node scripts/eleven-ttfa-probe.mjs
//
// Reads ELEVENLABS_API_KEY from the environment, falling back to a manual
// parse of .env.local at the repo root. The key itself (or any part of it)
// is never printed. All requests run strictly sequentially (never in
// parallel) so TTFA/total measurements aren't skewed by concurrent traffic,
// and audio is always read as a stream (never response.arrayBuffer(), which
// would collapse TTFA into total time).

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODEL_ID = "eleven_flash_v2_5"; // NOT eleven_multilingual_v2

const VOICES = {
  ta: { id: "wLIQpmGi7jT7aiEmDsE3", name: "Janani", languageCode: "ta" },
  hi: { id: "35h4XgJYQYdHtGbOCg7x", name: "Rohit", languageCode: "hi" },
};

const OUT_DIR = join(process.cwd(), "test-clips", "eleven-probe-out");

// ---------------------------------------------------------------------------
// Part A texts — natural general-conversation sentences (time, family, travel,
// money, plans), NOT tailoring/shop content. Character counts are printed at
// runtime rather than asserted here, so any drift is visible, not hidden.
const PART_A_TEXTS = {
  ta: [
    { label: "short", text: "நாளைக்கு அம்மாகிட்ட போய் வரேன்." },
    {
      label: "medium",
      text: "இந்த வாரம் ஊருக்கு போக டிக்கெட் புக் பண்ணிட்டேன், சனிக்கிழமை கிளம்புவேன்.",
    },
    {
      label: "long",
      text:
        "நேத்து அண்ணனுக்கு ஃபோன் பண்ணி பேசினேன், அவரு அடுத்த மாசம் வீட்டுக்கு வரதா சொன்னாரு. " +
        "நாமளும் கொஞ்சம் காசு சேர்த்து வச்சிட்டு, குடும்பமா ஒரு டிரிப் போலாம்னு பேசினோம்.",
    },
  ],
  hi: [
    { label: "short", text: "कल शाम मम्मी से मिलने जाऊँगा।" },
    {
      label: "medium",
      text: "इस हफ्ते गाँव जाने के लिए टिकट बुक कर लिया है, शनिवार सुबह निकलूंगा।",
    },
    {
      label: "long",
      text:
        "कल रात भाई से फोन पर बात हुई, उसने बताया कि वह अगले महीने घर वापस आने वाला है। " +
        "हमने सोचा कि थोड़ा पैसा जमा करके, इस बार पूरे परिवार के साथ कहीं घूमने चलेंगे।",
    },
  ],
};

// Part D — script-boundary defect inputs. One request per line.
const PART_D_LINES = [
  { index: 1, lang: "ta", text: "சைஸ் 36B" },
  { index: 2, lang: "ta", text: "சைஸ் 36 B" },
  { index: 3, lang: "ta", text: "சைஸ் 36பி" },
  { index: 4, lang: "hi", text: "ऑर्डर नंबर 4728" },
  { index: 5, lang: "hi", text: "ऑर्डर नंबर 4728" }, // identical repeat of #4
  { index: 6, lang: "hi", text: "कल 9:30 AM आइए" },
  { index: 7, lang: "hi", text: "कल 9:30 ए एम आइए" },
];

// ---------------------------------------------------------------------------
function loadKeyFromEnvLocal() {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === "ELEVENLABS_API_KEY") {
      return trimmed.slice(eq + 1).trim();
    }
  }
  return null;
}

function getApiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  const fromFile = loadKeyFromEnvLocal();
  if (fromFile) return fromFile;
  console.error(
    "ELEVENLABS_API_KEY is not set — checked process.env and .env.local in the repo root.",
  );
  process.exit(1);
}

function ensureOutDir() {
  mkdirSync(OUT_DIR, { recursive: true });
}

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

let requestCount = 0;
let non200Count = 0;
let totalCharsSent = 0;

/**
 * One streaming TTS request. Reads the body via the stream reader (never
 * arrayBuffer()) so TTFA is measured at the first non-empty chunk, not at
 * full-body completion. Returns the accumulated audio as a Buffer on success.
 */
async function streamRequest(voiceId, languageCode, text, outputFormat) {
  requestCount++;
  totalCharsSent += text.length;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${outputFormat}`;
  const body = JSON.stringify({ text, model_id: MODEL_ID, language_code: languageCode });
  const apiKey = getApiKey();

  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body,
    });
  } catch (err) {
    non200Count++;
    return { ok: false, status: "ERR", networkError: String(err?.message ?? err) };
  }

  if (res.status !== 200) {
    non200Count++;
    const bodyText = await res.text();
    return { ok: false, status: res.status, bodyText };
  }

  let ttfaMs = null;
  let bytes = 0;
  const chunks = [];
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      if (ttfaMs === null) ttfaMs = performance.now() - t0;
      bytes += value.length;
      chunks.push(value);
    }
  }
  const totalMs = performance.now() - t0;

  return { ok: true, status: res.status, ttfaMs, totalMs, bytes, buffer: Buffer.concat(chunks) };
}

function reportFailure(label, r) {
  if (r.networkError) {
    console.error(`  [${label}] request failed: ${r.networkError}`);
    return;
  }
  console.error(`  [${label}] HTTP ${r.status}`);
  console.error((r.bodyText ?? "").slice(0, 500));
}

function saveAudio(name, r) {
  if (!r.ok) return;
  const path = join(OUT_DIR, name);
  writeFileSync(path, r.buffer);
  console.log(`  wrote ${join("test-clips", "eleven-probe-out", name)}`);
}

// ---------------------------------------------------------------------------
async function runPartA() {
  console.log("\n=== Part A — latency, both languages ===\n");

  console.log("Text character counts:");
  for (const lang of ["ta", "hi"]) {
    for (const { label, text } of PART_A_TEXTS[lang]) {
      console.log(`  ${lang} ${label}: ${text.length} chars`);
    }
  }

  const rows = [];
  const medianInput = {}; // `${lang}-${label}` -> { ttfa: [], total: [] }

  for (const lang of ["ta", "hi"]) {
    const voice = VOICES[lang];
    for (const { label, text } of PART_A_TEXTS[lang]) {
      const key = `${lang}-${label}`;
      medianInput[key] = { ttfa: [], total: [] };
      for (let run = 1; run <= 3; run++) {
        const name = `A-${lang}-${label}-run${run}.mp3`;
        const r = await streamRequest(voice.id, voice.languageCode, text, "mp3_44100_128");
        if (!r.ok) {
          reportFailure(name, r);
          rows.push({ lang, label, run, status: r.status, ttfaMs: "-", totalMs: "-", bytes: "-" });
          continue;
        }
        saveAudio(name, r);
        rows.push({
          lang,
          label,
          run,
          status: r.status,
          ttfaMs: r.ttfaMs.toFixed(1),
          totalMs: r.totalMs.toFixed(1),
          bytes: r.bytes,
        });
        medianInput[key].ttfa.push(r.ttfaMs);
        medianInput[key].total.push(r.totalMs);
      }
    }
  }

  console.log("");
  printTable(rows, [
    { key: "lang", label: "lang", width: 4 },
    { key: "label", label: "text", width: 6 },
    { key: "run", label: "run", width: 3 },
    { key: "status", label: "status", width: 6 },
    { key: "ttfaMs", label: "ttfaMs", width: 8 },
    { key: "totalMs", label: "totalMs", width: 8 },
    { key: "bytes", label: "bytes", width: 8 },
  ]);

  console.log("\nPer-text medians:");
  for (const lang of ["ta", "hi"]) {
    for (const { label } of PART_A_TEXTS[lang]) {
      const { ttfa, total } = medianInput[`${lang}-${label}`];
      const medTtfa = median(ttfa);
      const medTotal = median(total);
      console.log(
        `  ${lang} ${label}: ttfaMs=${medTtfa === null ? "-" : medTtfa.toFixed(1)}  ` +
          `totalMs=${medTotal === null ? "-" : medTotal.toFixed(1)}  (n=${ttfa.length}/3 ok)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
async function runPartB() {
  console.log("\n=== Part B — nondeterminism (10x identical requests) ===\n");

  for (const lang of ["ta", "hi"]) {
    const voice = VOICES[lang];
    const text = PART_A_TEXTS[lang].find((t) => t.label === "short").text;
    const bytesList = [];
    const ttfaList = [];

    for (let run = 1; run <= 10; run++) {
      const name = `B-${lang}-run${run}.mp3`;
      const r = await streamRequest(voice.id, voice.languageCode, text, "mp3_44100_128");
      if (!r.ok) {
        reportFailure(name, r);
        continue;
      }
      saveAudio(name, r);
      bytesList.push(r.bytes);
      ttfaList.push(r.ttfaMs);
    }

    const distinct = new Set(bytesList).size;
    const min = bytesList.length ? Math.min(...bytesList) : null;
    const max = bytesList.length ? Math.max(...bytesList) : null;
    const medBytes = median(bytesList);
    const spreadPct = medBytes ? (((max - min) / medBytes) * 100).toFixed(2) : "-";

    const medTtfa = median(ttfaList);
    const minTtfa = ttfaList.length ? Math.min(...ttfaList) : null;
    const maxTtfa = ttfaList.length ? Math.max(...ttfaList) : null;

    console.log(`\n${lang} (${voice.name}) — text: ${JSON.stringify(text)}`);
    console.log(`  bytes (10 runs): ${bytesList.join(", ")}`);
    console.log(`  distinct byte sizes: ${distinct}`);
    console.log(`  min=${min}  max=${max}  spread=${spreadPct}% of median`);
    console.log(
      `  ttfaMs: median=${medTtfa === null ? "-" : medTtfa.toFixed(1)}  ` +
        `min=${minTtfa === null ? "-" : minTtfa.toFixed(1)}  max=${maxTtfa === null ? "-" : maxTtfa.toFixed(1)}`,
    );
  }
}

// ---------------------------------------------------------------------------
async function runPartC() {
  console.log("\n=== Part C — PCM check (pcm_24000, library voices) ===\n");

  for (const lang of ["ta", "hi"]) {
    const voice = VOICES[lang];
    const text = PART_A_TEXTS[lang].find((t) => t.label === "short").text;
    const name = `C-${lang}.pcm`;
    const r = await streamRequest(voice.id, voice.languageCode, text, "pcm_24000");
    if (!r.ok) {
      console.log(`${lang}: status=${r.status}`);
      if (r.networkError) {
        console.log(`  request failed: ${r.networkError}`);
      } else {
        console.log(`  body: ${(r.bodyText ?? "").slice(0, 300)}`);
      }
      continue;
    }
    saveAudio(name, r);
    console.log(`${lang}: status=${r.status}  bytes=${r.bytes}  ttfaMs=${r.ttfaMs.toFixed(1)}`);
  }
}

// ---------------------------------------------------------------------------
async function runPartD() {
  console.log("\n=== Part D — script-boundary defect inputs ===\n");

  const mapping = [];
  for (const { index, lang, text } of PART_D_LINES) {
    const voice = VOICES[lang];
    const name = `D-${index}-${lang}.mp3`;
    const r = await streamRequest(voice.id, voice.languageCode, text, "mp3_44100_128");
    if (!r.ok) {
      reportFailure(name, r);
    } else {
      saveAudio(name, r);
    }
    mapping.push({ index, lang, text, filename: name, status: r.status });
  }

  console.log("\nIndex → text → filename:");
  printTable(mapping, [
    { key: "index", label: "#", width: 2 },
    { key: "lang", label: "lang", width: 4 },
    { key: "text", label: "text", width: 20 },
    { key: "filename", label: "filename", width: 20 },
    { key: "status", label: "status", width: 6 },
  ]);
}

// ---------------------------------------------------------------------------
async function main() {
  getApiKey(); // fail fast, before touching the filesystem or network
  ensureOutDir();

  await runPartA();
  await runPartB();
  await runPartC();
  await runPartD();

  console.log("\n=== Summary ===");
  console.log(`Total requests: ${requestCount}`);
  console.log(`Non-200 responses: ${non200Count}`);
  console.log(`Total input characters sent: ${totalCharsSent}`);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
