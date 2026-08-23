// Throwaway deploy-verification script — NOT part of the app. Polls the live
// deployment's /api/translate until the new transliteration debug fields
// appear (proof the new build is being served), then reports the result.

import { readFileSync } from "node:fs";

const BASE_URL = "https://lingobridge-tamil-hindi-translator.vercel.app";
const endpoint = `${BASE_URL}/api/translate`;
const CLIP = "test-clips/hi-05.wav";
const MAX_ATTEMPTS = 8;
const WAIT_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attempt() {
  const buf = readFileSync(CLIP);
  const fd = new FormData();
  fd.append("audio", new Blob([buf], { type: "audio/wav" }), "hi-05.wav");
  fd.append("sourceLang", "hi");

  const res = await fetch(endpoint, { method: "POST", body: fd });
  const json = await res.json();
  return { ok: res.ok, json };
}

async function main() {
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const { ok, json } = await attempt();
    const hasField = json?.debug && Object.prototype.hasOwnProperty.call(json.debug, "transliterationTriggered");
    if (hasField) {
      console.log(JSON.stringify({ attempts: i, ok, result: json }, null, 2));
      return;
    }
    console.log(`attempt ${i}: field absent (ok=${ok}) — ${i < MAX_ATTEMPTS ? `waiting ${WAIT_MS}ms` : "giving up"}`);
    if (i < MAX_ATTEMPTS) await sleep(WAIT_MS);
  }
  console.log(JSON.stringify({ attempts: MAX_ATTEMPTS, failed: true }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
