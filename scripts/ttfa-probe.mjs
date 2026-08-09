// MEASUREMENT PROBE — not part of the app or the eval suite.
// Measures streaming time-to-first-audio (TTFA) on a Gemini SSE endpoint: per
// clip, time-to-first-audio-chunk, time-to-complete, total bytes; 3 runs/clip ->
// min/median/max.
//
// NOTE: endpoint, model, and the RESULTS path below are HARDCODED to the
// gemini-3.1-flash-tts-preview TTS run. Slice 4's first task is measuring
// translate time-to-first-token — GENERALISE this then (parameterise endpoint/
// model/results, point it at translate :streamGenerateContent). Committed as-is
// so the working probe isn't lost; regenerating from memory is more expensive
// than carrying an imperfect file.

import { readFileSync } from "node:fs";

const RESULTS = "eval-results/2026-08-09T08-18-09-458Z-gemini-direct-gemini-3.1-flash-lite.json";
const MODEL = "gemini-3.1-flash-tts-preview";
const VOICE = "Kore";
const CLIPS = ["ta-06", "hi-10", "hi-02", "hi-09"];
const RUNS = 3;
const GAP_MS = 10000; // ~6 req/min, conservative for a preview quota
// 3.1 Flash TTS pricing, USD per 1M tokens (ai.google.dev/pricing).
const TEXT_PER_M = 1.0;
const AUDIO_PER_M = 20.0;
const USD_INR = 88;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (readFileSync(".env.local", "utf8").match(/GEMINI_API_KEY=(.+)/) || [])[1].trim();

function ttsBody(text) {
  return {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
    },
  };
}

// One streaming call. Returns {ttfaMs, completeMs, bytes, usage} or {noAudio}.
async function streamOnce(text) {
  const t0 = Date.now();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(ttsBody(text)),
    },
  );
  if (res.status === 429) {
    let sec = 60;
    try {
      const j = await res.json();
      for (const d of j?.error?.details || []) {
        const m = typeof d.retryDelay === "string" && d.retryDelay.match(/([\d.]+)s/);
        if (m) sec = Math.ceil(parseFloat(m[1]));
      }
    } catch {}
    return { rateLimit: sec };
  }
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);

  let ttfaMs = null;
  let bytes = 0;
  let usage = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let j;
      try {
        j = JSON.parse(payload);
      } catch {
        continue;
      }
      for (const p of j.candidates?.[0]?.content?.parts || []) {
        if (p.inlineData?.data) {
          const n = Buffer.from(p.inlineData.data, "base64").length;
          if (n > 0 && ttfaMs === null) ttfaMs = Date.now() - t0;
          bytes += n;
        }
      }
      if (j.usageMetadata) usage = j.usageMetadata;
    }
  }
  const completeMs = Date.now() - t0;
  if (ttfaMs === null) return { noAudio: true };
  return { ttfaMs, completeMs, bytes, usage };
}

// Handle the short-input no-audio quirk (pad + retry) and 429 (wait) so a run
// always yields a measurement.
async function measure(text) {
  const variants = [text, text.replace(/[।.!?\s]+$/u, "") + ".", text.replace(/[।.!?\s]+$/u, "") + " ."];
  for (let i = 0; i < 5; i++) {
    const r = await streamOnce(variants[Math.min(i, variants.length - 1)]);
    if (r.rateLimit) {
      console.log(`      429 -> wait ${r.rateLimit}s`);
      await sleep(r.rateLimit * 1000);
      continue;
    }
    if (r.noAudio) {
      console.log(`      no-audio, padding + retry`);
      continue;
    }
    return r;
  }
  throw new Error("no measurement after retries");
}

function cost(usage) {
  if (!usage) return 0;
  const textTok = usage.promptTokenCount || 0;
  const audioTok =
    (usage.candidatesTokensDetails || [])
      .filter((d) => d.modality === "AUDIO")
      .reduce((s, d) => s + (d.tokenCount || 0), 0) || usage.candidatesTokenCount || 0;
  return (textTok * TEXT_PER_M + audioTok * AUDIO_PER_M) / 1e6;
}
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0], median: s[(s.length - 1) >> 1], max: s[s.length - 1] };
};
const money = (u) => `$${u.toFixed(6)} (₹${(u * USD_INR).toFixed(4)})`;

async function main() {
  const data = JSON.parse(readFileSync(RESULTS, "utf8"));
  const textOf = Object.fromEntries(data.results.map((r) => [r.file.replace(/\.wav$/, ""), r.translation]));

  console.log(`Streaming TTFA probe — ${MODEL}, voice ${VOICE}, ${RUNS} runs/clip\n`);
  let totalCost = 0;
  let first = true;
  for (const clip of CLIPS) {
    const text = textOf[clip];
    const ttfas = [];
    const completes = [];
    let bytes = 0;
    console.log(`${clip}: ${JSON.stringify(text)}`);
    for (let run = 0; run < RUNS; run++) {
      if (!first) await sleep(GAP_MS);
      first = false;
      const r = await measure(text);
      ttfas.push(r.ttfaMs);
      completes.push(r.completeMs);
      bytes = r.bytes;
      totalCost += cost(r.usage);
      console.log(`   run ${run + 1}: ttfa ${r.ttfaMs}ms  complete ${r.completeMs}ms  ${r.bytes}B`);
    }
    const t = stats(ttfas);
    const c = stats(completes);
    console.log(
      `   => TTFA  min ${t.min} / med ${t.median} / max ${t.max} ms  |  ` +
        `COMPLETE min ${c.min} / med ${c.median} / max ${c.max} ms  |  ${bytes}B\n`,
    );
  }
  console.log(`Total probe cost: ${money(totalCost)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
