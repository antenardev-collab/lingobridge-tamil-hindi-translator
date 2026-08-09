import { buildInstruction } from "../prompt";
import { resolveModel } from "../models";
import { estimateCost } from "./cost";
import { parseTranslateResult } from "./validate";
import type { TranslateInput, TranslateOutput, TranslatePipeline } from "./types";

/**
 * Pipeline B — gemini-direct: one Google Gemini generateContent call with inline
 * wav audio. Direct to Google (not via OpenRouter), using GEMINI_API_KEY.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiPart {
  text?: string;
}
interface GeminiTokenDetail {
  modality?: string;
  tokenCount?: number;
}

export const geminiDirect: TranslatePipeline = {
  id: "gemini-direct",
  async run(input: TranslateInput): Promise<TranslateOutput> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

    const model = resolveModel("gemini-direct", input.model);
    const endpoint = `${BASE}/${model.id}:generateContent`;

    const body = {
      systemInstruction: {
        parts: [{ text: buildInstruction(input.sourceLang) }],
      },
      contents: [
        {
          role: "user",
          parts: [
            { text: "Translate the attached audio." },
            {
              inlineData: {
                mimeType: `audio/${input.audioFormat}`,
                data: input.audioBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0,
      },
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = await res.json();
    const parts: GeminiPart[] = json?.candidates?.[0]?.content?.parts ?? [];
    const content = parts.map((p) => p.text ?? "").join("");
    const result = parseTranslateResult(content);

    const um = json?.usageMetadata ?? {};
    const promptTokens: number = um.promptTokenCount ?? 0;
    const completionTokens: number = um.candidatesTokenCount ?? 0;
    const audioTokens: number = (um.promptTokensDetails ?? [])
      .filter((d: GeminiTokenDetail) => d.modality === "AUDIO")
      .reduce((sum: number, d: GeminiTokenDetail) => sum + (d.tokenCount ?? 0), 0);
    const costUsd = estimateCost(
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
    };
  },
};
