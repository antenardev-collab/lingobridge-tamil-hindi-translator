import type { PriceTable } from "../models";

/**
 * Compute USD cost from token counts. Audio input is priced separately from
 * text, so callers pass the text-token count (prompt minus audio) and the audio
 * count distinctly. Used as the source of truth for Gemini (which has no cost
 * field) and as a fallback for OpenRouter when usage.cost is absent.
 */
export function estimateCost(
  price: PriceTable | undefined,
  textInputTokens: number,
  audioInputTokens: number,
  outputTokens: number,
): number {
  if (!price) return 0;
  return (
    (textInputTokens * price.textInputPerM +
      audioInputTokens * price.audioInputPerM +
      outputTokens * price.outputPerM) /
    1_000_000
  );
}
