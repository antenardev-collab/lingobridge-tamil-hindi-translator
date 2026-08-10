/**
 * Every model ID and its pricing lives here (Hard rule: no model strings
 * elsewhere). Slice 2 runs an empirical A/B between two *pipelines* — a pipeline
 * is a provider + wire format, not just a model — so each pipeline owns a set of
 * models you can switch between with `npm run eval -- --model=<id>`.
 *
 * Verify IDs and prices against the provider before trusting them; they change:
 *   - OpenRouter chat audio input: openrouter.ai/openai/gpt-audio-mini
 *   - Gemini audio input + pricing: ai.google.dev/gemini-api/docs/pricing
 */

export type PipelineId = "openrouter-single" | "gemini-direct";

/** USD per 1M tokens. Audio input is metered separately from text on both APIs. */
export interface PriceTable {
  textInputPerM: number;
  audioInputPerM: number;
  outputPerM: number;
}

export interface ModelConfig {
  /** Exact provider slug sent on the wire. */
  id: string;
  label: string;
  price: PriceTable;
  note?: string;
}

export interface PipelineConfig {
  id: PipelineId;
  provider: "openrouter" | "gemini";
  defaultModel: string;
  models: Record<string, ModelConfig>;
}

export const PIPELINES: Record<PipelineId, PipelineConfig> = {
  // Pipeline A — one OpenRouter chat/completions call with input_audio (wav).
  // OpenRouter exposes ONLY these two models with audio input on chat
  // completions. There is no Gemini audio input via OpenRouter — that path is
  // Pipeline B, direct to Google.
  "openrouter-single": {
    id: "openrouter-single",
    provider: "openrouter",
    defaultModel: "openai/gpt-audio-mini",
    models: {
      "openai/gpt-audio-mini": {
        id: "openai/gpt-audio-mini",
        label: "GPT Audio Mini",
        // Headline input $0.60 / output $2.40 per 1M. Audio in billed at the
        // input rate. ~0.82s P50 — the fast option.
        price: { textInputPerM: 0.6, audioInputPerM: 0.6, outputPerM: 2.4 },
      },
      "openai/gpt-audio": {
        id: "openai/gpt-audio",
        label: "GPT Audio",
        // Much dearer: audio in $32 / output $64 per 1M. Alternate only.
        price: { textInputPerM: 2.5, audioInputPerM: 32, outputPerM: 64 },
        note: "Frontier audio model — 50x the audio-input cost of mini. A/B ceiling, not a default.",
      },
    },
  },

  // Pipeline B — one Google Gemini generateContent call with inline wav audio.
  "gemini-direct": {
    id: "gemini-direct",
    provider: "gemini",
    defaultModel: "gemini-3.1-flash-lite",
    models: {
      "gemini-3.1-flash-lite": {
        id: "gemini-3.1-flash-lite",
        label: "Gemini 3.1 Flash-Lite",
        // Default: cheapest/fastest audio-in Flash-Lite AVAILABLE to new keys.
        // gemini-2.5-flash-lite is cheaper on paper ($0.30 audio in) but Google
        // 404s it for new users, so it's not an option here (locked decision 3).
        price: { textInputPerM: 0.25, audioInputPerM: 0.5, outputPerM: 1.5 },
      },
      "gemini-3.6-flash": {
        id: "gemini-3.6-flash",
        label: "Gemini 3.6 Flash",
        price: { textInputPerM: 1.5, audioInputPerM: 1.5, outputPerM: 7.5 },
        note: "Most capable Flash — slowest and dearest. Alternate only (locked decision 3: latency beats quality).",
      },
    },
  },
};

/**
 * Default when the caller doesn't specify a pipeline. This is gemini-direct,
 * the pipeline LOCKED by the Slice 2 A/B (CLAUDE.md → Stack): gpt-audio-mini's
 * Tamil STT was rejected. The client omits `pipeline` and inherits this — one
 * source of truth. openrouter-single stays selectable explicitly for A/B runs.
 * NOTE: scripts/eval.mjs has its own separate default and does NOT read this.
 */
export const DEFAULT_PIPELINE: PipelineId = "gemini-direct";

export function isPipelineId(x: string): x is PipelineId {
  return x === "openrouter-single" || x === "gemini-direct";
}

/** Resolve the model config, falling back to the pipeline default. */
export function resolveModel(pipeline: PipelineId, model?: string): ModelConfig {
  const cfg = PIPELINES[pipeline];
  const id = model || cfg.defaultModel;
  const found = cfg.models[id];
  if (!found) {
    throw new Error(
      `model "${id}" is not registered for pipeline "${pipeline}". ` +
        `Known: ${Object.keys(cfg.models).join(", ")}`,
    );
  }
  return found;
}
