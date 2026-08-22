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
  /**
   * Slice 4d: carries the caller's deadline (app/api/translate/route.ts
   * owns the timeout policy). Optional so pipelines that don't read it stay
   * valid — but a pipeline which ignores this is unbounded: it will run
   * until the provider call itself resolves or rejects, with nothing
   * enforcing the caller's deadline.
   */
  signal?: AbortSignal;
}

/**
 * Slice 4a: server-clock marks around the provider call, so the route can
 * decompose function time. All are Node `performance.now()` ms (one process, one
 * clock). `firstByte` is null unless the call actually streams — a non-streaming
 * `generateContent` has no honest token TTFT, so we do not invent one.
 */
export interface PipelineTiming {
  /** Just before the provider fetch. */
  requestSent: number;
  /** Provider response headers, when streaming; else null. */
  firstByte: number | null;
  /** Provider body fully read. */
  complete: number;
  /** Does OUR code stream this provider call? (Names our impl, not model capability.) */
  weStream: boolean;
}

export interface TranslateOutput extends TranslateResult {
  usage: TranslateUsage;
  /** The model actually used (after default resolution). */
  model: string;
  /** Raw model text, kept for debugging — never returned by the API route. */
  raw: string;
  /** Server-clock timing marks around the provider call (Slice 4a). */
  timing: PipelineTiming;
  /**
   * Fine-grained trace of this provider call, when the pipeline populates one
   * (Slice 4a+). Optional so pipelines without a trace (openrouter-single)
   * stay valid — do not add a required field here.
   */
  trace?: ProviderTrace;
}

/**
 * Slice 4a+ fine-grained marks + response metadata for one Gemini
 * generateContent call, on the SAME clock as PipelineTiming
 * (`performance.now()`, one process). Currently populated only by
 * gemini-direct; openrouter-single has no equivalent and is unaffected.
 */
export interface ProviderTrace {
  /** Just after the request body string has been built (end of our own serialisation cost). */
  payloadReady: number;
  /** Immediately before fetch() is called. */
  fetchStart: number;
  /**
   * Immediately after the fetch promise resolves — i.e. response headers
   * received. NOT a token TTFT: this is a non-streaming generateContent call,
   * so Gemini generates the whole reply before opening the HTTP response.
   * This mark covers upload + queueing + inference + first-response-byte
   * together, not "first token" — do not read it as one.
   */
  headers: number;
  /** After the response body has been fully read as text. */
  bodyRead: number;
  /** After JSON.parse of that text. */
  parsed: number;
  /**
   * Byte length of the serialised request body. Uses Buffer.byteLength, not
   * .length — the payload is mostly base64 ASCII (fixed-width) but the system
   * instruction is Tamil/Hindi/English text, which is not.
   */
  requestBytes: number;
  /** Byte length of the response body text. */
  responseBytes: number;
  /**
   * 1 for the first Gemini call this process makes, incrementing thereafter.
   * Per-process — resets to 1 whenever the Vercel instance is replaced.
   */
  callIndexInProcess: number;
  /** candidates[0].finishReason. Null if absent from the response. */
  finishReason: string | null;
  /** Gemini's modelVersion field. Null if absent from the response. */
  modelVersion: string | null;
  /** Gemini's responseId field. Null if absent from the response. */
  responseId: string | null;
  /** modelStatus.modelStage. Null if absent from the response. */
  modelStage: string | null;
  /** usageMetadata.serviceTier. Null if absent from the response. */
  serviceTier: string | null;
  /**
   * usageMetadata.totalTokenCount. Null means the field was absent from the
   * response — distinct from an actual 0, so this is never defaulted to 0.
   */
  totalTokens: number | null;
  /**
   * usageMetadata.thoughtsTokenCount. Null means the field was absent from
   * the response — distinct from an actual 0, so this is never defaulted to 0.
   */
  thoughtsTokens: number | null;
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
