import type { NormalizedPricing, OpenRouterEndpoint, OpenRouterPricing } from "./types";

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

/**
 * Stable identity for each endpoint in one model's endpoint list — the key the
 * price change-log is written against.
 *
 * A provider can serve the same model several times over: OpenAI as `openai`,
 * `openai/flex` and `openai/priority`, Azure per region. Those carry distinct
 * tags. But OpenRouter also publishes genuine duplicates — two
 * `google-vertex/us-south1` entries for qwen3-235b at different prices, alike
 * in every other field — and a shared key makes the two take turns overwriting
 * each other, one phantom "price change" per entry per sweep, forever.
 *
 * Duplicates are therefore ordered by price (cheapest keeps the bare tag, the
 * rest get `#2`, `#3`) rather than by their position in the response: position
 * is the one thing about a duplicate that nothing guarantees.
 */
export function endpointTags(endpoints: OpenRouterEndpoint[]): string[] {
  const fallback = (e: OpenRouterEndpoint) => e.tag || e.provider_name || e.name || "unknown";
  const groups = new Map<string, number[]>();
  endpoints.forEach((e, i) => {
    const tag = fallback(e);
    groups.set(tag, [...(groups.get(tag) ?? []), i]);
  });

  const tags: string[] = new Array(endpoints.length);
  for (const [tag, idx] of groups) {
    if (idx.length === 1) {
      tags[idx[0]!] = tag;
      continue;
    }
    const priceOf = (i: number) => {
      const p = normalizePricing(endpoints[i]!.pricing);
      return [p.promptUsd ?? Infinity, p.completionUsd ?? Infinity, endpoints[i]!.context_length ?? 0] as const;
    };
    const ordered = [...idx].sort((a, b) => {
      const pa = priceOf(a);
      const pb = priceOf(b);
      return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2] || a - b;
    });
    ordered.forEach((i, rank) => {
      tags[i] = rank === 0 ? tag : `${tag}#${rank + 1}`;
    });
  }
  return tags;
}
