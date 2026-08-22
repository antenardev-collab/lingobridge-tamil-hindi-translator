import { NextResponse } from "next/server";
import { DEFAULT_PIPELINE, isPipelineId } from "@/lib/models";
import { runTranslate, TranslateValidationError } from "@/lib/translate";
import type { ServerDebug } from "@/lib/types";
import type { PipelineTiming, ProviderTrace } from "@/lib/translate/types";

/**
 * Slice 4a cold-start detector. Module scope, so it survives across invocations
 * of one warm (Fluid) instance: true on the first request this instance serves,
 * false thereafter. Read-then-set below so the first response reports `true`.
 */
let INSTANCE_WARMED = false;

/**
 * Build the server-clock latency decomposition. Every field is a delta between
 * two marks from the SAME Node `performance.now()` clock — never mixed with the
 * client's clock (they aren't synchronised). `timing` is null on the error path
 * (the provider call never returned marks), so only the entry→exit envelope is
 * reported there.
 */
function buildDebug(
  entry: number,
  exit: number,
  coldStart: boolean,
  execRegion: string | null,
  edgeTrace: string | null,
  timing: PipelineTiming | null,
  trace: ProviderTrace | undefined,
): ServerDebug {
  const round = (ms: number) => Math.round(ms);
  const entryToRequestMs = timing ? round(timing.requestSent - entry) : 0;
  const requestToCompleteMs = timing ? round(timing.complete - timing.requestSent) : 0;
  const completeToExitMs = timing ? round(exit - timing.complete) : 0;
  // Measured directly as entry→exit, NOT summed from the parts, so residualMs can
  // surface time no named interval captured (plus per-field rounding).
  const serverTotalMs = round(exit - entry);
  const debug: ServerDebug = {
    coldStart,
    execRegion,
    edgeTrace,
    weStream: timing?.weStream ?? false,
    entryToRequestMs,
    requestToFirstByteMs:
      timing && timing.firstByte !== null ? round(timing.firstByte - timing.requestSent) : null,
    requestToCompleteMs,
    completeToExitMs,
    serverTotalMs,
    residualMs: serverTotalMs - (entryToRequestMs + requestToCompleteMs + completeToExitMs),
  };

  // providerTrace is OMITTED (not set to a zeroed object) when there's no
  // timing or no trace — e.g. the error path, or a pipeline that doesn't
  // populate one. An absent trace and an all-zero trace must not look the same.
  if (timing && trace) {
    const serialiseMs = round(trace.payloadReady - timing.requestSent);
    const preFetchMs = round(trace.fetchStart - trace.payloadReady);
    const fetchToHeadersMs = round(trace.headers - trace.fetchStart);
    const bodyDownloadMs = round(trace.bodyRead - trace.headers);
    const parseMs = round(trace.parsed - trace.bodyRead);
    debug.providerTrace = {
      serialiseMs,
      preFetchMs,
      fetchToHeadersMs,
      bodyDownloadMs,
      parseMs,
      traceResidualMs:
        requestToCompleteMs - (serialiseMs + preFetchMs + fetchToHeadersMs + bodyDownloadMs + parseMs),
      requestBytes: trace.requestBytes,
      responseBytes: trace.responseBytes,
      callIndexInProcess: trace.callIndexInProcess,
      finishReason: trace.finishReason,
      modelVersion: trace.modelVersion,
      responseId: trace.responseId,
      modelStage: trace.modelStage,
      serviceTier: trace.serviceTier,
      totalTokens: trace.totalTokens,
      thoughtsTokens: trace.thoughtsTokens,
    };
  }

  return debug;
}

/**
 * POST /api/translate — pipeline-agnostic STT+translate.
 *
 * Accepts multipart/form-data:
 *   audio       (File)   required — the utterance, wav
 *   sourceLang  ('ta'|'hi') required — which side tapped (locked decision 1)
 *   pipeline    (string) optional — 'openrouter-single' | 'gemini-direct'
 *   model       (string) optional — override the pipeline default (A/B)
 *
 * Returns validated, typed JSON only (Hard rule) — never raw model output.
 * Node runtime: needs Buffer and the server-side API keys.
 */
export const runtime = "nodejs";

export async function POST(req: Request) {
  // Slice 4a marks (server clock). `entry` is the earliest we can observe; read
  // the cold-start flag here and flip it so the first invocation reports true.
  const entry = performance.now();
  const coldStart = !INSTANCE_WARMED;
  INSTANCE_WARMED = true;
  // execRegion is the AUTHORITATIVE execution region (Vercel's own docs:
  // "The ID of the Region where the app is running", runtime-only). edgeTrace is
  // the raw x-vercel-id request header, kept verbatim for reference only — it's
  // edge-appended BEFORE the function runs, so it names the nearest edge PoP to
  // the caller (e.g. bom1 for a Chennai client), NOT the execution region. That
  // conflation already produced one wrong regional conclusion on this project —
  // see PLAN.md → Slice 4.
  const execRegion = process.env.VERCEL_REGION ?? null;
  const edgeTrace = req.headers.get("x-vercel-id");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "expected multipart/form-data" },
      { status: 400 },
    );
  }

  const audio = form.get("audio");
  const sourceLang = form.get("sourceLang");
  const pipeline = (form.get("pipeline") as string) || DEFAULT_PIPELINE;
  const model = (form.get("model") as string) || undefined;

  if (!(audio instanceof Blob)) {
    return NextResponse.json({ error: "missing 'audio' file" }, { status: 400 });
  }
  if (sourceLang !== "ta" && sourceLang !== "hi") {
    return NextResponse.json(
      { error: "'sourceLang' must be 'ta' or 'hi'" },
      { status: 400 },
    );
  }
  if (!isPipelineId(pipeline)) {
    return NextResponse.json(
      { error: `unknown pipeline: ${pipeline}` },
      { status: 400 },
    );
  }

  // The route trusts these bytes are WAV: downstream it labels them audio/wav
  // without inspecting or transcoding. Verify the RIFF/WAVE magic number so a
  // client-side capture regression (e.g. the worklet emitting the wrong format)
  // surfaces as a clear 400 here instead of an opaque Gemini failure. Check both
  // markers — "RIFF" at 0..3 alone is shared with AVI/WebP and other RIFF
  // containers; "WAVE" at 8..11 is what makes it a WAV. This contract belongs at
  // the endpoint because it is the interface that survives a future native rebuild.
  const buf = Buffer.from(await audio.arrayBuffer());
  if (
    buf.length < 12 ||
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return NextResponse.json(
      { error: "'audio' must be WAV (RIFF/WAVE)" },
      { status: 400 },
    );
  }

  const audioBase64 = buf.toString("base64");

  try {
    const out = await runTranslate(pipeline, {
      audioBase64,
      audioFormat: "wav",
      sourceLang,
      model,
    });
    const exit = performance.now();
    // `debug` is ADDITIVE and non-breaking: scripts/eval.mjs reads only
    // original/translation/model/usage/error/detail and ignores unknown keys.
    return NextResponse.json({
      original: out.original,
      translation: out.translation,
      pipeline,
      model: out.model,
      usage: out.usage,
      debug: buildDebug(entry, exit, coldStart, execRegion, edgeTrace, out.timing, out.trace),
    });
  } catch (err) {
    const exit = performance.now();
    // No provider marks on the error path — report just the entry→exit envelope
    // so a slow *failure* is still measurable.
    const debug = buildDebug(entry, exit, coldStart, execRegion, edgeTrace, null, undefined);
    if (err instanceof TranslateValidationError) {
      // Already logged with raw text inside runTranslate; surface a clean error.
      return NextResponse.json(
        { error: "model returned malformed output", detail: err.message, debug },
        { status: 502 },
      );
    }
    const detail = err instanceof Error ? err.message : "unknown error";
    console.error(`[api/translate] ${detail}`);
    return NextResponse.json(
      { error: "translation failed", detail, debug },
      { status: 502 },
    );
  }
}
