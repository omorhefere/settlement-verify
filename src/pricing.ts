import type { TokenUsage } from "./extractors/anthropic.ts";

// USD per million tokens, by model ID: [input, output]. Haiku's price applies
// to prompts of 100K tokens or fewer, which a letter always is. Check the
// provider's price list when adding a model.
export const USD_PER_MILLION_TOKENS_BY_MODEL: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};

// Cost of one model call in USD, from its token usage, or undefined for a
// model with no listed price.
export const costUsdOfTokenUsage = (tokenUsage: TokenUsage): number | undefined => {
  const pricePerMillionTokens = USD_PER_MILLION_TOKENS_BY_MODEL[tokenUsage.model];
  return pricePerMillionTokens
    ? (tokenUsage.inputTokens * pricePerMillionTokens[0] + tokenUsage.outputTokens * pricePerMillionTokens[1]) / 1_000_000
    : undefined;
};
