import { buildInstruction } from "../prompt";
import { resolveModel } from "../models";
import { estimateCost } from "./cost";
import { parseTranslateResult } from "./validate";
import type { TranslateInput, TranslateOutput, TranslatePipeline } from "./types";

/**
 * Pipeline A — openrouter-single: one OpenRouter chat/completions call with the
 * input_audio content type (format wav). STT + translation in a single hop.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export const openrouterSingle: TranslatePipeline = {
  id: "openrouter-single",
  async run(input: TranslateInput): Promise<TranslateOutput> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

    const model = resolveModel("openrouter-single", input.model);

    const body = {
      model: model.id,
      modalities: ["text"],
      // NB: gpt-audio / gpt-audio-mini reject response_format:json_object, so we
      // rely on the prompt's "output only JSON" instruction + defensive parsing.
      // Ask OpenRouter to return the actual billed cost, so the A/B uses real
      // numbers rather than our price table where possible.
      usage: { include: true },
      messages: [
        { role: "system", content: buildInstruction(input.sourceLang) },
        {
          role: "user",
          content: [
            { type: "text", text: "Translate the attached audio." },
            {
              type: "input_audio",
              input_audio: { data: input.audioBase64, format: input.audioFormat },
            },
          ],
        },
      ],
    };

    // Slice 4a marks — non-streaming (single chat/completions call). See the
    // gemini-direct note: firstByte stays null, we report complete-time.
    const requestSent = performance.now();
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = await res.json();
    const complete = performance.now();
    const content: string = json?.choices?.[0]?.message?.content ?? "";
    const result = parseTranslateResult(content);

    const usage = json?.usage ?? {};
    const promptTokens: number = usage.prompt_tokens ?? 0;
    const completionTokens: number = usage.completion_tokens ?? 0;
    const audioTokens: number = usage.prompt_tokens_details?.audio_tokens ?? 0;
    const costUsd =
      typeof usage.cost === "number"
        ? usage.cost
        : estimateCost(
            model.price,
            Math.max(0, promptTokens - audioTokens),
            audioTokens,
            completionTokens,
          );

    return {
      ...result,
      model: model.id,
      raw: content,
      usage: { promptTokens, audioTokens, completionTokens, costUsd },
      timing: { requestSent, firstByte: null, complete, weStream: false },
    };
  },
};
