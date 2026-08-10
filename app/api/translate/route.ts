import { NextResponse } from "next/server";
import { DEFAULT_PIPELINE, isPipelineId } from "@/lib/models";
import { runTranslate, TranslateValidationError } from "@/lib/translate";

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
    return NextResponse.json({
      original: out.original,
      translation: out.translation,
      pipeline,
      model: out.model,
      usage: out.usage,
    });
  } catch (err) {
    if (err instanceof TranslateValidationError) {
      // Already logged with raw text inside runTranslate; surface a clean error.
      return NextResponse.json(
        { error: "model returned malformed output", detail: err.message },
        { status: 502 },
      );
    }
    const detail = err instanceof Error ? err.message : "unknown error";
    console.error(`[api/translate] ${detail}`);
    return NextResponse.json(
      { error: "translation failed", detail },
      { status: 502 },
    );
  }
}
