import type { NormalizedPricing, OpenRouterPricing } from "./types";

/** Parse an OpenRouter price string (USD, per token/unit) into a float or null. */
export function parseUsd(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function normalizePricing(pricing: OpenRouterPricing | undefined): NormalizedPricing {
  const p = pricing ?? {};
  return {
    promptUsd: parseUsd(p.prompt),
    completionUsd: parseUsd(p.completion),
    requestUsd: parseUsd(p.request),
    imageUsd: parseUsd(p.image),
    webSearchUsd: parseUsd(p.web_search),
    internalReasoningUsd: parseUsd(p.internal_reasoning),
    cacheReadUsd: parseUsd(p.input_cache_read),
    cacheWriteUsd: parseUsd(p.input_cache_write),
  };
}

/** Fields that define a meaningful price change (drives change-log inserts). */
const CHANGE_FIELDS: (keyof NormalizedPricing)[] = [
  "promptUsd",
  "completionUsd",
  "requestUsd",
  "imageUsd",
  "webSearchUsd",
  "internalReasoningUsd",
  "cacheReadUsd",
  "cacheWriteUsd",
];

/** True when two normalized prices differ on any tracked field. */
export function pricingChanged(a: NormalizedPricing | null, b: NormalizedPricing): boolean {
  if (a === null) return true;
  return CHANGE_FIELDS.some((field) => !numbersEqual(a[field], b[field]));
}

function numbersEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  // Prices are exact decimals; compare with a tiny relative tolerance to avoid
  // float representation noise triggering spurious change-log rows.
  if (a === b) return true;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return diff <= scale * 1e-12;
}

export function isFreePricing(p: NormalizedPricing): boolean {
  return (p.promptUsd ?? 0) === 0 && (p.completionUsd ?? 0) === 0;
}

/**
 * Estimate USD spend for a token volume.
 *
 * When prompt/completion counts are known, price each side with its own rate.
 * Otherwise blend prompt+completion using `promptShare` (fraction of tokens that
 * are input). Returns null when no usable price exists.
 */
export function estimateSpendUsd(args: {
  totalTokens: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  promptUsd: number | null;
  completionUsd: number | null;
  promptShare?: number;
}): number | null {
  const { promptUsd, completionUsd } = args;
  if (promptUsd === null && completionUsd === null) return null;
  const pUsd = promptUsd ?? 0;
  const cUsd = completionUsd ?? 0;

  if (args.promptTokens != null && args.completionTokens != null) {
    return args.promptTokens * pUsd + args.completionTokens * cUsd;
  }

  if (args.totalTokens == null) return null;
  const promptShare = clamp(args.promptShare ?? 0.9, 0, 1);
  const prompt = args.totalTokens * promptShare;
  const completion = args.totalTokens * (1 - promptShare);
  return prompt * pUsd + completion * cUsd;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * A single blended $/Mtok figure for quick comparison. Defaults to a 90/10
 * input/output mix — observed market traffic is overwhelmingly input-heavy.
 */
export function blendedPricePerMtok(p: NormalizedPricing, promptShare = 0.9): number | null {
  if (p.promptUsd === null && p.completionUsd === null) return null;
  const blended = (p.promptUsd ?? 0) * promptShare + (p.completionUsd ?? 0) * (1 - promptShare);
  return blended * 1_000_000;
}
