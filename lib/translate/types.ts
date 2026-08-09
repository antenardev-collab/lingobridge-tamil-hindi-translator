import type { Side } from "../types";

export type { Side };

/** The validated shape every pipeline returns — callers can't tell them apart. */
export interface TranslateResult {
  original: string;
  translation: string;
}

/** Token counts + resolved cost for one call, for the eval A/B (cost per clip). */
export interface TranslateUsage {
  promptTokens: number;
  /** Subset of prompt tokens that were audio, when the provider reports it. */
  audioTokens: number;
  completionTokens: number;
  /** USD. Provider-reported when available, else computed from the price table. */
  costUsd: number;
}

export interface TranslateInput {
  audioBase64: string;
  /** One of the OpenRouter/Gemini accepted formats — we standardize on "wav". */
  audioFormat: string;
  sourceLang: Side;
  /** Override the pipeline's default model (A/B via `--model=`). */
  model?: string;
}

export interface TranslateOutput extends TranslateResult {
  usage: TranslateUsage;
  /** The model actually used (after default resolution). */
  model: string;
  /** Raw model text, kept for debugging — never returned by the API route. */
  raw: string;
}

export interface TranslatePipeline {
  id: string;
  run(input: TranslateInput): Promise<TranslateOutput>;
}

/**
 * Thrown when the model's output can't be parsed/validated into a
 * TranslateResult. Carries the raw text so the retry/route layer can log the
 * evidence needed to fix the prompt (never discard it).
 */
export class TranslateValidationError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "TranslateValidationError";
    this.raw = raw;
  }
}
