/**
 * Slice 4d deadline model — shared by the server (app/api/translate/route.ts)
 * and the client (app/page.tsx) so their two deadlines cannot drift apart.
 * Import-safe from the browser: pure numbers and arithmetic only, no
 * `Buffer`, no Node-only global — do not add anything here that isn't.
 *
 * The Gemini call is linear in speech length: source is the Slice 4d
 * longform probe (docs/PLAN.md → Slice 4d step 1), 32 requests, four Tamil
 * clips 1.92–30.59s — least-squares fit requestToCompleteMs ≈ 795ms + 64ms
 * per second of audio. Headroom is FIXED, not proportional to duration: the
 * observed tail overshoots the linear prediction by a roughly constant
 * amount regardless of turn length (a 3.4s clip once overshot by 2813ms; a
 * 30.6s clip by 1973ms).
 */
export const DEADLINE_BASE_MS = 795;
export const DEADLINE_PER_SEC_MS = 64;
export const DEADLINE_HEADROOM_MS = 2500;
/** Used when duration can't be parsed or is outside the plausible range —
 * degrading toward a long wait is safer than aborting a healthy turn on an
 * unparsed duration. */
export const DEADLINE_FALLBACK_MS = 8000;
export const MIN_PLAUSIBLE_DURATION_SEC = 0.1;
export const MAX_PLAUSIBLE_DURATION_SEC = 120;

/**
 * Extra wallclock allowed on top of the server's own deadline, for the
 * client-side backstop below — network transport, queueing, and anything
 * else outside the server function's own clock.
 */
export const CLIENT_TRANSPORT_ALLOWANCE_MS = 3000;

export const TRANSLITERATE_BUDGET_MS = 2500;

/**
 * "client-hint" is never returned by computeServerDeadline itself — it
 * exists so callers with a third tier (server parse → client-supplied hint
 * → fallback, see app/api/translate/route.ts) can label that middle tier
 * without a separate type. computeServerDeadline only ever returns
 * "measured" or "fallback".
 */
export type DeadlineSource = "measured" | "client-hint" | "fallback";

/**
 * The server-side deadline applied to one Gemini call, and whether it was
 * derived from a measured duration or the fixed fallback. Same logic
 * app/api/translate/route.ts ran inline before this module existed — moved
 * here, not changed.
 */
export function computeServerDeadline(
  audioDurationSec: number | null,
): { deadlineMs: number; deadlineSource: DeadlineSource } {
  if (
    audioDurationSec !== null &&
    audioDurationSec >= MIN_PLAUSIBLE_DURATION_SEC &&
    audioDurationSec <= MAX_PLAUSIBLE_DURATION_SEC
  ) {
    return {
      deadlineMs: DEADLINE_BASE_MS + DEADLINE_PER_SEC_MS * audioDurationSec + DEADLINE_HEADROOM_MS,
      deadlineSource: "measured",
    };
  }
  return { deadlineMs: DEADLINE_FALLBACK_MS, deadlineSource: "fallback" };
}

/**
 * The client-side backstop timeout around the whole /api/translate request.
 * Bounds the BROWSER's wait — the server-side AbortController only bounds
 * the server's own wait on Gemini; without this, a dead network or a
 * response that never arrives hangs the turn forever.
 *
 * No max() against DEADLINE_FALLBACK_MS here (Slice 4d step 2) — that
 * guarded against the server falling back to 8000ms while the client
 * computed a shorter deadline from the same duration. That divergence is
 * now removed at the source instead: the client sends its own measured
 * duration to the server as a hint (app/page.tsx's `durationSec` field),
 * used whenever the server's own WAV parse fails or is implausible. The
 * server only reaches DEADLINE_FALLBACK_MS when BOTH its own parse and the
 * client's hint fail — and if the client's hint is unusable, the client's
 * own `audioDurationSec` was unavailable too, so this function also falls
 * through to DEADLINE_FALLBACK_MS via computeServerDeadline(null) below.
 * Both sides land on the same fallback anyway, without a max().
 */
export function computeClientBackstopMs(audioDurationSec: number | null): number {
  const { deadlineMs } = computeServerDeadline(audioDurationSec);
  return deadlineMs + TRANSLITERATE_BUDGET_MS + CLIENT_TRANSPORT_ALLOWANCE_MS;
}
