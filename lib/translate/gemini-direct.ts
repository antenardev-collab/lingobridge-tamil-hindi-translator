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

/**
 * Shape of the fields we actually read from a generateContent response body.
 * Not a full schema of Gemini's response — every field optional, mirroring
 * GeminiPart/GeminiTokenDetail above, so an absent field types as undefined
 * (?? then resolves it to null, never 0 or "").
 */
interface GeminiCandidate {
  content?: {
    parts?: GeminiPart[];
  };
  finishReason?: string;
}
interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  promptTokensDetails?: GeminiTokenDetail[];
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  serviceTier?: string;
}
interface GeminiModelStatus {
  modelStage?: string;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  responseId?: string;
  modelStatus?: GeminiModelStatus;
}

/**
 * Slice 4a+ per-process call counter, read into ProviderTrace.callIndexInProcess.
 * Module scope like route.ts's INSTANCE_WARMED: persists across invocations of
 * one warm (Fluid) instance and resets to 0 whenever Vercel replaces the
 * instance — so this counts calls on ONE instance, not globally.
 */
let callCount = 0;

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

    // Slice 4a marks. This is a non-streaming generateContent call: the fetch
    // promise resolves only after Gemini has generated the whole reply, so
    // header-arrival is NOT a token TTFT. We therefore record complete-time and
    // leave firstByte null (streaming:false) rather than pass off body-download
    // as a first-token number.
    // requestSent and complete keep their original positions (immediately
    // before serialisation begins, and immediately after the response is
    // parsed) so requestToCompleteMs stays numerically comparable to every
    // measurement already recorded in docs/PLAN.md. The Slice 4a+ marks below
    // (payloadReady..parsed) subdivide that same span; none of them move the
    // span's endpoints.
    const requestSent = performance.now();
    const payload = JSON.stringify(body);
    const payloadReady = performance.now();
    const requestBytes = Buffer.byteLength(payload);

    callCount += 1;
    const callIndexInProcess = callCount;

    const fetchStart = performance.now();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: payload,
      signal: input.signal,
    });
    const headers = performance.now();

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini ${res.status}: ${text.slice(0, 500)}`);
    }

    const text = await res.text();
    const bodyRead = performance.now();
    const responseBytes = Buffer.byteLength(text);

    let json: GeminiResponse;
    try {
      json = JSON.parse(text);
    } catch {
      // Do not let a bare SyntaxError propagate — name the failure and keep
      // the same "first N chars of the body" evidence style as the !res.ok
      // branch above.
      throw new Error(`Gemini response parse failure: ${text.slice(0, 500)}`);
    }
    const parsed = performance.now();
    // complete stays immediately after parsing, as before Slice 4a+.
    const complete = parsed;

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

    // Response metadata beyond usage — read defensively, never defaulted to 0
    // or "" (absent must stay distinguishable from a real zero/empty value).
    const finishReason: string | null = json?.candidates?.[0]?.finishReason ?? null;
    const modelVersion: string | null = json?.modelVersion ?? null;
    const responseId: string | null = json?.responseId ?? null;
    const modelStage: string | null = json?.modelStatus?.modelStage ?? null;
    const serviceTier: string | null = json?.usageMetadata?.serviceTier ?? null;
    const totalTokens: number | null = json?.usageMetadata?.totalTokenCount ?? null;
    const thoughtsTokens: number | null = json?.usageMetadata?.thoughtsTokenCount ?? null;

    return {
      ...result,
      model: model.id,
      raw: content,
      usage: { promptTokens, audioTokens, completionTokens, costUsd },
      timing: { requestSent, firstByte: null, complete, weStream: false },
      trace: {
        payloadReady,
        fetchStart,
        headers,
        bodyRead,
        parsed,
        requestBytes,
        responseBytes,
        callIndexInProcess,
        finishReason,
        modelVersion,
        responseId,
        modelStage,
        serviceTier,
        totalTokens,
        thoughtsTokens,
      },
    };
  },
};
