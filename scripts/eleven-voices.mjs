// Lists the ElevenLabs voices callable by this account's API key, so we can
// see what's actually available on the current plan before wiring TTS to it.
// No dependencies — Node built-ins and global fetch only.
//
//   node scripts/eleven-voices.mjs
//
// Reads ELEVENLABS_API_KEY from the environment, falling back to a manual
// parse of .env.local at the repo root. The key itself (or any prefix/suffix
// of it) is never printed.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const VOICES_URL = "https://api.elevenlabs.io/v1/voices";

function loadKeyFromEnvLocal() {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
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

function padCell(value, width) {
  const s = String(value ?? "");
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

async function main() {
  const apiKey = getApiKey();

  let res;
  try {
    res = await fetch(VOICES_URL, {
      method: "GET",
      headers: { "xi-api-key": apiKey },
    });
  } catch (err) {
    console.error(`Request to ${VOICES_URL} failed: ${err?.message ?? err}`);
    process.exit(1);
  }

  if (res.status !== 200) {
    const body = await res.text();
    console.error(`ElevenLabs returned HTTP ${res.status}`);
    console.error(body.slice(0, 500));
    process.exit(1);
  }

  const json = await res.json();
  const voices = Array.isArray(json?.voices) ? json.voices : [];

  const rows = voices.map((v) => {
    const labels = v.labels && typeof v.labels === "object" ? v.labels : {};
    return {
      voice_id: v.voice_id ?? "",
      name: v.name ?? "",
      category: v.category ?? "",
      language: labels.language ?? "",
      accent: labels.accent ?? "",
    };
  });

  const cols = [
    { key: "voice_id", label: "voice_id", width: 24 },
    { key: "name", label: "name", width: 24 },
    { key: "category", label: "category", width: 14 },
    { key: "language", label: "language", width: 10 },
    { key: "accent", label: "accent", width: 14 },
  ];
  for (const row of rows) {
    for (const col of cols) {
      col.width = Math.max(col.width, String(row[col.key] ?? "").length);
    }
  }

  const headerLine = cols.map((c) => padCell(c.label, c.width)).join("  ");
  console.log(headerLine);
  console.log(cols.map((c) => "-".repeat(c.width)).join("  "));
  for (const row of rows) {
    console.log(cols.map((c) => padCell(row[c.key], c.width)).join("  "));
  }

  const byCategory = {};
  for (const row of rows) {
    const cat = row.category || "(none)";
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }
  const categories = Object.keys(byCategory).sort();

  console.log("");
  console.log(`Total voices: ${rows.length}`);
  console.log(
    `By category: ${categories.map((c) => `${c}=${byCategory[c]}`).join(", ") || "(none)"}`,
  );
  console.log(`Distinct categories: ${categories.join(", ") || "(none)"}`);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
