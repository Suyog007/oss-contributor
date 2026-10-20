import type { Env } from '@/config/env';

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok: number;
}

/**
 * Pricing is configuration, not a hard-coded fact.
 *
 * The provider's published prices change independently of this codebase, so
 * the table below is a conservative placeholder used only when no price has
 * been configured. It deliberately over-estimates: a budget check that fails
 * closed is a minor annoyance, whereas one that under-counts silently spends
 * real money. Token counts are stored on every call, so cost can be recomputed
 * at any time with `pnpm tsx scripts/recost.ts` after prices are configured
 * through AI_PRICING_OVERRIDES.
 *
 * Set AI_PRICING_OVERRIDES to the values from the provider's pricing page:
 *   {"accounts/fireworks/models/your-model":{"inputPerMTok":0.2,"outputPerMTok":0.8}}
 */
export const PLACEHOLDER_PRICE: ModelPrice = {
  inputPerMTok: 1.0,
  outputPerMTok: 2.0,
  cachedInputPerMTok: 0.25,
};

const DEFAULTS: Record<string, ModelPrice> = {
  // Known-good cheap tier for extraction and classification style work.
  'accounts/fireworks/models/deepseek-v4p1-flash': { inputPerMTok: 0.2, outputPerMTok: 0.8, cachedInputPerMTok: 0.05 },
  // Stronger tier used for hypothesis generation, planning, and adversarial review.
  'accounts/fireworks/models/kimi-k3': { inputPerMTok: 0.6, outputPerMTok: 2.4, cachedInputPerMTok: 0.15 },
};

export function priceFor(model: string, overrides: Env['AI_PRICING_OVERRIDES']): ModelPrice {
  const override = overrides[model];
  if (override) {
    return {
      inputPerMTok: override.inputPerMTok,
      outputPerMTok: override.outputPerMTok,
      cachedInputPerMTok: override.cachedInputPerMTok ?? override.inputPerMTok,
    };
  }
  return DEFAULTS[model] ?? PLACEHOLDER_PRICE;
}

export function isPlaceholderPricing(model: string, overrides: Env['AI_PRICING_OVERRIDES']): boolean {
  return !(overrides[model] || DEFAULTS[model]);
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedPromptTokens: number;
}

export const EMPTY_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  cachedPromptTokens: 0,
};

export function estimateCostUsd(price: ModelPrice, promptTokens: number, maxOutputTokens: number): number {
  return (
    (promptTokens / 1_000_000) * price.inputPerMTok +
    (maxOutputTokens / 1_000_000) * price.outputPerMTok
  );
}

export function costUsd(price: ModelPrice, usage: Usage): number {
  const uncachedPrompt = Math.max(0, usage.promptTokens - usage.cachedPromptTokens);
  return (
    (uncachedPrompt / 1_000_000) * price.inputPerMTok +
    (usage.cachedPromptTokens / 1_000_000) * price.cachedInputPerMTok +
    (usage.completionTokens / 1_000_000) * price.outputPerMTok
  );
}

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Rough token estimate for pre-flight budgeting. Deliberately conservative
 * (over-estimates) because it is used to decide whether a call is affordable.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5) + 8;
}
