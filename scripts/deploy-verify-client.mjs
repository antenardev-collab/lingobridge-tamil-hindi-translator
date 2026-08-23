// Throwaway deploy-verification script — NOT part of the app. Confirms the
// new client-side "xlit:" debug line has actually shipped, by fetching the
// deployed page HTML, pulling every <script src> it references, and
// searching those JS bundles for the literal "xlit: " string that only the
// new page.tsx code produces. scripts/deploy-verify.mjs only checks the
// server-side /api/translate debug payload, which can't prove a CLIENT
// bundle rebuilt — hence this separate check.

const BASE_URL = "https://lingobridge-tamil-hindi-translator.vercel.app";
const MAX_ATTEMPTS = 8;
const WAIT_MS = 15000;
const SEARCH_STRING = process.argv[2] || "xlit: ";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attempt() {
  const htmlRes = await fetch(BASE_URL, { cache: "no-store" });
  const html = await htmlRes.text();
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const urls = srcs.map((s) => (s.startsWith("http") ? s : new URL(s, BASE_URL).href));

  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      const text = await res.text();
      if (text.includes(SEARCH_STRING)) {
        return { found: true, url };
      }
    } catch {
      // ignore a single chunk fetch failure, keep checking the rest
    }
  }
  return { found: false, scriptsChecked: urls.length };
}

async function main() {
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const result = await attempt();
    if (result.found) {
      console.log(JSON.stringify({ attempts: i, ...result }, null, 2));
      return;
    }
    console.log(
      `attempt ${i}: not found (checked ${result.scriptsChecked} scripts) — ` +
        `${i < MAX_ATTEMPTS ? `waiting ${WAIT_MS}ms` : "giving up"}`,
    );
    if (i < MAX_ATTEMPTS) await sleep(WAIT_MS);
  }
  console.log(JSON.stringify({ attempts: MAX_ATTEMPTS, failed: true }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
