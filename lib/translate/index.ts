import type { PipelineId } from "../models";
import { geminiDirect } from "./gemini-direct";
import { openrouterSingle } from "./openrouter-single";
import { TranslateValidationError } from "./types";
import type { TranslateInput, TranslateOutput, TranslatePipeline } from "./types";

const REGISTRY: Record<PipelineId, TranslatePipeline> = {
  "openrouter-single": openrouterSingle,
  "gemini-direct": geminiDirect,
};

export function getPipeline(id: PipelineId): TranslatePipeline {
  const pipeline = REGISTRY[id];
  if (!pipeline) throw new Error(`unknown pipeline: ${id}`);
  return pipeline;
}

/**
 * Run a pipeline with ONE retry on malformed output (per Slice 2 spec). Only
 * validation failures retry — network/auth errors throw immediately. Every
 * validation failure logs the raw model text, since that's the evidence needed
 * to fix the prompt.
 */
export async function runTranslate(
  id: PipelineId,
  input: TranslateInput,
): Promise<TranslateOutput> {
  const pipeline = getPipeline(id);
  const maxAttempts = 2;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await pipeline.run(input);
    } catch (err) {
      lastError = err;
      if (err instanceof TranslateValidationError) {
        console.error(
          `[translate:${id}] attempt ${attempt}/${maxAttempts} validation failed: ${err.message}\n` +
            `  raw: ${err.raw}`,
        );
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

export { TranslateValidationError };
