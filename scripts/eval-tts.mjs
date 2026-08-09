// TTS listening-eval batch (NOT Slice 4 UI). Reads an eval-results/*.json file
// and speaks each clip's translation to eval-audio/<run-name>/ so the
// translations can be judged by ear.
//
//   npm run eval:tts                                  # newest results, default handful
//   npm run eval:tts -- --results=eval-results/<f>.json --clips=ta-13,hi-13
//   npm run eval:tts -- --clips=all                   # every clip in the file
//   npm run eval:tts -- --clips=hi-01,hi-02 --rpm=12  # pace to <=12 req/min
//
// One TTS engine (Gemini native TTS) for both pipelines, so we compare
// translations, not voices. Gemini TTS covers Tamil AND Hindi. It returns PCM
// (24kHz mono 16-bit) — we wrap it as WAV (no audio dependency; MP3 would need
// an encoder). Requires GEMINI_API_KEY in .env.local.
//
// For any translation containing Latin-script words, a second `-translit`
// variant is produced with those words rewritten into the target script.
//
// The run is PACED (default <=12 req/min) and RESUMABLE: any clip whose .wav
// already exists is skipped, and index.txt is appended to, never overwritten.

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, basename } from "node:path";

// Gemini 2.5 Flash Preview TTS pricing, USD per 1M tokens (ai.google.dev/pricing).
const TTS_TEXT_PER_M = 0.5;
const TTS_AUDIO_PER_M = 10.0;
// gemini-3.1-flash-lite text pricing, for the transliteration calls.
const XLIT_TEXT_IN_PER_M = 0.25;
const XLIT_TEXT_OUT_PER_M = 1.5;
const USD_INR = 88;

const RESULTS_DIR = "eval-results";
const OUT_ROOT = "eval-audio";
const DEFAULT_CLIPS = ["ta-11", "ta-13", "hi-13", "hi-05"];
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models";

// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const ttsModel = args.model || "gemini-2.5-flash-preview-tts";
const xlitModel = args["translit-model"] || "gemini-3.1-flash-lite";
const voice = args.voice || "Kore";

// Pacing: keep total request rate at/under --rpm (default 12/min). --delay=<ms>
// sets the minimum gap between request STARTS directly (overrides --rpm).
const RPM = args.rpm ? Number(args.rpm) : 12;
const minGapMs = args.delay ? Number(args.delay) : Math.ceil(60000 / RPM);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnv() {
  try {
    for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* rely on ambient env */
  }
}

function newestResults() {
  const files = readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (!files.length) throw new Error(`no results files in ${RESULTS_DIR}/`);
  return join(RESULTS_DIR, files[files.length - 1]);
}

function otherScript(sourceLang) {
  return sourceLang === "ta" ? "Devanagari (Hindi) script" : "Tamil script";
}

// ---------------------------------------------------------------------------
function pcmToWav(pcm, sampleRate, channels = 1, bits = 16) {
  const blockAlign = (channels * bits) / 8;
  const byteRate = sampleRate * blockAlign;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Map any Devanagari (०-९) or Tamil (௦-௯) digit back to ASCII, so the
// transliterator can never change a number's script — the only difference
// between a base/translit pair must be the loanword letters.
function normalizeDigits(s) {
  return s.replace(/[०-९௦-௯]/g, (ch) => {
    const c = ch.codePointAt(0);
    const base = c >= 0x0be6 ? 0x0be6 : 0x0966;
    return String(c - base);
  });
}

// ---------------------------------------------------------------------------
// Paced, retrying request layer. gate() enforces the min gap between request
// STARTS so the whole run stays under the per-minute quota.
let lastStartAt = 0;
async function gate() {
  const wait = minGapMs - (Date.now() - lastStartAt);
  if (wait > 0) await sleep(wait);
  lastStartAt = Date.now();
}

function parseRetryDelaySec(json) {
  for (const d of json?.error?.details || []) {
    if (typeof d.retryDelay === "string") {
      const m = d.retryDelay.match(/([\d.]+)s/);
      if (m) return Math.ceil(parseFloat(m[1]));
    }
  }
  return null;
}

// One request through the gate. Classifies failures so callers can react:
// rate-limit (429) vs transient (5xx/network) vs hard error (throw).
async function requestOnce(model, body, ctx) {
  await gate();
  ctx.attempts++;
  let res;
  try {
    res = await fetch(`${GEMINI}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, kind: "transient", detail: String(e?.message ?? e) };
  }
  if (res.status === 429) {
    let retryDelaySec = null;
    try {
      retryDelaySec = parseRetryDelaySec(await res.json());
    } catch {
      /* no body */
    }
    return { ok: false, kind: "rate-limit", retryDelaySec };
  }
  if (res.status >= 500) return { ok: false, kind: "transient", detail: `HTTP ${res.status}` };
  if (res.status === 400) {
    // Gemini TTS sometimes 400s with "tried to generate text ... should only be
    // used for TTS" instead of emitting audio — same no-audio class as
    // finishReason:OTHER. Treat it as retryable no-audio; other 400s are real.
    const body = await res.text();
    if (/only be used for TTS|tried to generate text/i.test(body)) {
      return { ok: false, kind: "no-audio", reason: "400-text" };
    }
    throw new Error(`Gemini 400: ${body.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { ok: true, json: await res.json() };
}

// Retries 429 (honouring the server's retryDelay, else 60s) and transient
// errors (exponential backoff + jitter). Records each retry's cause in ctx.
async function requestWithRetry(model, body, label, ctx) {
  const MAX_RATE_LIMIT = 5;
  const MAX_TRANSIENT = 4;
  let rateLimited = 0;
  let transient = 0;
  for (;;) {
    const r = await requestOnce(model, body, ctx);
    if (r.ok) return { json: r.json };
    // No-audio is not a retryable transport error — hand it back so the TTS
    // caller can advance to a padded short-input variant.
    if (r.kind === "no-audio") return { noAudio: true, reason: r.reason };
    if (r.kind === "rate-limit") {
      if (++rateLimited > MAX_RATE_LIMIT) {
        throw new Error(`${label}: 429 rate-limit — gave up after ${rateLimited - 1} waits`);
      }
      const waitSec = r.retryDelaySec ?? 60;
      ctx.causes.push(`429(wait ${waitSec}s)`);
      console.log(`    ${label}: 429 rate-limit → waiting ${waitSec}s (retry ${rateLimited}/${MAX_RATE_LIMIT})`);
      await sleep(waitSec * 1000);
    } else {
      if (++transient > MAX_TRANSIENT) {
        throw new Error(`${label}: transient failure — gave up after ${transient - 1} retries (${r.detail})`);
      }
      const backoff = Math.round(1000 * 2 ** (transient - 1) * (1 + Math.random() * 0.3));
      ctx.causes.push(`transient:${r.detail}`);
      console.log(`    ${label}: transient (${r.detail}) → backoff ${backoff}ms (retry ${transient}/${MAX_TRANSIENT})`);
      await sleep(backoff);
    }
  }
}

function ttsBody(text) {
  return {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
}

// Gemini TTS intermittently returns finishReason:OTHER with no audio on very
// short inputs (e.g. "ठीक है"); appending an ASCII "." makes it reliable, and it
// is flaky rather than deterministic, so we retry across padded variants. This
// no-audio path is separate from the 429/transient handling in requestWithRetry,
// so short-input failures and rate-limits are never conflated. Returns the exact
// string synthesised (usedText), wall-clock synth time, attempt count, and the
// list of retry causes.
async function synth(text, label) {
  const trimmed = text.replace(/[।.!?\s]+$/u, "");
  const variants = [text, `${trimmed}.`, `${trimmed}.`, `${trimmed} .`];
  const ctx = { attempts: 0, causes: [] };
  const t0 = Date.now();
  for (const usedText of variants) {
    const res = await requestWithRetry(ttsModel, ttsBody(usedText), `${label} synth`, ctx);
    if (res.noAudio) {
      ctx.causes.push(`no-audio(${res.reason})`);
      continue; // try the next (padded) variant
    }
    const json = res.json;
    const part = json?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (part) {
      const pcm = Buffer.from(part.data, "base64");
      const rate = parseInt((part.mimeType.match(/rate=(\d+)/) || [])[1] || "24000", 10);
      const um = json.usageMetadata || {};
      const textTokens = um.promptTokenCount || 0;
      const audioTokens =
        (um.candidatesTokensDetails || [])
          .filter((d) => d.modality === "AUDIO")
          .reduce((s, d) => s + (d.tokenCount || 0), 0) || um.candidatesTokenCount || 0;
      const costUsd = (textTokens * TTS_TEXT_PER_M + audioTokens * TTS_AUDIO_PER_M) / 1e6;
      return {
        wav: pcmToWav(pcm, rate),
        durationSec: pcm.length / 2 / rate,
        textTokens,
        audioTokens,
        costUsd,
        usedText,
        synthMs: Date.now() - t0,
        attempts: ctx.attempts,
        causes: ctx.causes,
      };
    }
    ctx.causes.push("no-audio(OTHER)");
  }
  throw new Error(`${label}: no audio after ${variants.length} short-input variants (finishReason OTHER)`);
}

async function transliterate(text, sourceLang) {
  const prompt =
    `Rewrite the text below so any words currently in Latin/English letters are ` +
    `written phonetically in ${otherScript(sourceLang)}. Keep the meaning, wording, ` +
    `and order identical. Do NOT change any digits or numbers — leave every digit ` +
    `exactly as written, in the same Latin/Arabic numerals (e.g. 8000 stays 8000). ` +
    `Output only the rewritten text.\n\nText: ${text}`;
  const ctx = { attempts: 0, causes: [] };
  const { json } = await requestWithRetry(
    xlitModel,
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } },
    "translit",
    ctx,
  );
  // Strip intra-word hyphens the transliterator inserts (e.g. "வொர்க்-கு"): a
  // hyphen between two script letters makes Gemini TTS 400 ("tried to generate
  // text"), and it is a romanisation artifact, not part of the word.
  const out = normalizeDigits(
    (json?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text ?? "")
      .join("")
      .trim(),
  ).replace(/(?<=\S)[-–—](?=\S)/gu, "");
  const um = json.usageMetadata || {};
  const costUsd =
    ((um.promptTokenCount || 0) * XLIT_TEXT_IN_PER_M +
      (um.candidatesTokenCount || 0) * XLIT_TEXT_OUT_PER_M) /
    1e6;
  return { text: out, costUsd };
}

const money = (usd) => `$${usd.toFixed(6)} (₹${(usd * USD_INR).toFixed(4)})`;
const triesLabel = (r) => (r.attempts > 1 ? ` (${r.attempts} tries: ${r.causes.join(", ")})` : "");

// ---------------------------------------------------------------------------
async function main() {
  loadEnv();
  const resultsPath = args.results || newestResults();
  const data = JSON.parse(readFileSync(resultsPath, "utf8"));
  const pipeline = data.meta?.pipeline || "unknown";
  const runName = basename(resultsPath, ".json");
  // Output folder is keyed by TTS model so runs with different TTS engines
  // (e.g. 2.5 vs 3.1) never share a directory or index.txt.
  const outDir = join(OUT_ROOT, `${runName}__${ttsModel}`);

  let selection;
  if (args.clips === "all") selection = null;
  else if (args.clips) selection = new Set(args.clips.split(",").map((c) => c.replace(/\.wav$/, "")));
  else {
    selection = new Set(DEFAULT_CLIPS);
    console.log(`No --clips given — using default handful: ${DEFAULT_CLIPS.join(", ")}`);
    console.log(`(pass --clips=all for every clip, or --clips=a,b,c)\n`);
  }

  const clips = data.results.filter((r) => {
    if (r.error) return false;
    if (!selection) return true;
    return selection.has(r.file.replace(/\.wav$/, ""));
  });
  if (!clips.length) {
    console.error("No matching non-error clips in the results file.");
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const indexPath = join(outDir, "index.txt");
  if (!existsSync(indexPath)) {
    writeFileSync(
      indexPath,
      `TTS listening-eval — ${runName}\n` +
        `pipeline=${pipeline} tts=${ttsModel} voice=${voice}\n` +
        `started ${new Date().toISOString()}\n` +
        `${"=".repeat(70)}\n`,
    );
  }
  // Filenames already recorded, so re-runs never double-log an entry.
  const indexed = new Set();
  for (const line of readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab > 0) indexed.add(line.slice(0, tab));
  }
  const appendIndex = (name, tag, synthLabel, text) => {
    if (indexed.has(name)) return;
    appendFileSync(indexPath, `${name}\t${tag}\t${synthLabel}\t${text}\n`);
    indexed.add(name);
  };

  console.log(`Results: ${resultsPath}`);
  console.log(`Pipeline: ${pipeline}  TTS: ${ttsModel}  voice: ${voice}`);
  console.log(
    `Pacing:  <=${(60000 / minGapMs).toFixed(1)} req/min (>=${minGapMs}ms between calls)` +
      `${args.delay ? " [--delay override]" : ""}`,
  );
  console.log(`Output:  ${outDir}/\n`);

  let total = 0;
  let generated = 0;
  let skipped = 0;
  const failures = [];

  for (const r of clips) {
    const stem = r.file.replace(/\.wav$/, "");
    const tgt = r.sourceLang === "ta" ? "hi" : "ta";
    const hasLatin = /[A-Za-z]/.test(r.translation);

    // Base variant.
    const baseName = `${stem}-${pipeline}.wav`;
    if (existsSync(join(outDir, baseName))) {
      console.log(`${baseName.padEnd(34)} exists — skipping`);
      skipped++;
    } else {
      try {
        const b = await synth(r.translation, stem);
        writeFileSync(join(outDir, baseName), b.wav);
        total += b.costUsd;
        generated++;
        console.log(
          `${baseName.padEnd(34)} ${b.durationSec.toFixed(1)}s audio  synth ${b.synthMs}ms${triesLabel(b)}  ` +
            `tok ${b.textTokens}+${b.audioTokens}a  ${money(b.costUsd)}${hasLatin ? "  [has-latin]" : ""}`,
        );
        appendIndex(baseName, `[${r.sourceLang}→${tgt}]`, `synth=${b.synthMs}ms`, b.usedText);
      } catch (e) {
        console.log(`${baseName.padEnd(34)} FAILED — ${e.message}`);
        failures.push(baseName);
      }
    }

    // Transliterated variant — Latin words rewritten into the target script.
    if (hasLatin) {
      const tName = `${stem}-${pipeline}-translit.wav`;
      if (existsSync(join(outDir, tName))) {
        console.log(`${tName.padEnd(34)} exists — skipping`);
        skipped++;
      } else {
        try {
          const x = await transliterate(r.translation, r.sourceLang);
          const tb = await synth(x.text, `${stem}-translit`);
          writeFileSync(join(outDir, tName), tb.wav);
          total += x.costUsd + tb.costUsd;
          generated++;
          console.log(
            `${tName.padEnd(34)} ${tb.durationSec.toFixed(1)}s audio  synth ${tb.synthMs}ms${triesLabel(tb)}  ` +
              `tok ${tb.textTokens}+${tb.audioTokens}a  ${money(tb.costUsd + x.costUsd)}  (incl. translit)`,
          );
          appendIndex(tName, `[translit]`, `synth=${tb.synthMs}ms`, tb.usedText);
        } catch (e) {
          console.log(`${tName.padEnd(34)} FAILED — ${e.message}`);
          failures.push(tName);
        }
      }
    }
  }

  // Reconcile: some .wav files exist on disk from earlier runs whose index
  // entries were lost (index was overwritten before it appended). Add rows for
  // them so the index covers every file present. Their synth time can't be
  // recovered — mark it n/a.
  let reconciled = 0;
  for (const r of data.results) {
    if (r.error) continue;
    const stem = r.file.replace(/\.wav$/, "");
    const tgt = r.sourceLang === "ta" ? "hi" : "ta";
    const baseName = `${stem}-${pipeline}.wav`;
    if (existsSync(join(outDir, baseName)) && !indexed.has(baseName)) {
      appendIndex(baseName, `[${r.sourceLang}→${tgt}]`, `synth=n/a (prior run)`, r.translation);
      reconciled++;
    }
    if (/[A-Za-z]/.test(r.translation)) {
      const tName = `${stem}-${pipeline}-translit.wav`;
      if (existsSync(join(outDir, tName)) && !indexed.has(tName)) {
        appendIndex(tName, `[translit]`, `synth=n/a (prior run)`, `(transliterated variant of ${stem} — text not recorded)`);
        reconciled++;
      }
    }
  }

  console.log(
    `\nGenerated ${generated}, skipped ${skipped} existing` +
      `${reconciled ? `, reconciled ${reconciled} orphaned index rows` : ""}` +
      `${failures.length ? `, FAILED ${failures.length}` : ""}.`,
  );
  if (failures.length) console.log(`Failed to synthesize: ${failures.join(", ")}`);
  console.log(`This run's cost: ${money(total)}`);
  console.log(`Index: ${indexPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
