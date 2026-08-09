import type { TranslateResult } from "./types";
import { TranslateValidationError } from "./types";

/**
 * Parse a model's text response into a validated TranslateResult. Models wrap
 * JSON in markdown fences and occasionally add prose, so we strip fences and, as
 * a last resort, grab the first {...} block. Fails loudly (Hard rule) with the
 * raw text attached so the caller can log it.
 */
export function parseTranslateResult(raw: string): TranslateResult {
  const cleaned = stripFences(raw);

  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new TranslateValidationError("no JSON object in model output", raw);
    }
    try {
      obj = JSON.parse(match[0]);
    } catch {
      throw new TranslateValidationError("unparseable JSON in model output", raw);
    }
  }

  if (typeof obj !== "object" || obj === null) {
    throw new TranslateValidationError("model output is not a JSON object", raw);
  }

  const rec = obj as Record<string, unknown>;
  if (typeof rec.original !== "string" || typeof rec.translation !== "string") {
    throw new TranslateValidationError(
      "model output missing string 'original'/'translation'",
      raw,
    );
  }

  const original = rec.original.trim();
  const translation = rec.translation.trim();
  if (!original || !translation) {
    throw new TranslateValidationError("empty 'original' or 'translation'", raw);
  }

  return { original, translation };
}

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}
