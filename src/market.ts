import type { ModelWithLatest } from "./storage";

export interface MarketAggregates {
  totalModels: number;
  activeModels: number;
  freeModels: number;
  avgPromptUsdPerMtok: number | null;
  medianPromptUsdPerMtok: number | null;
  usageWeightedPromptUsdPerMtok: number | null;
  cheapestFrontierUsdPerMtok: number | null;
}

/** $/Mtok blended across a 50/50 input/output mix (falls back to whichever side exists). */
export function blendedPerMtok(promptUsd: number | null, completionUsd: number | null): number | null {
  if (promptUsd === null && completionUsd === null) return null;
  return ((promptUsd ?? completionUsd ?? 0) * 0.5 + (completionUsd ?? promptUsd ?? 0) * 0.5) * 1_000_000;
}

/**
 * Market-wide price/volume aggregates over the current model set.
 * `models` should already be the active set with latest prices + latest usage.
 */
export function computeMarketAggregates(models: ModelWithLatest[], totalModels: number): MarketAggregates {
  const active = models.filter((m) => m.isActive);
  const freeModels = active.filter((m) => m.isFree).length;

  const paid = active.filter((m) => m.promptUsd !== null && m.promptUsd > 0);
  const promptPerMtok = paid.map((m) => m.promptUsd! * 1_000_000).sort((a, b) => a - b);
  const avg = mean(promptPerMtok);
  const median = medianOf(promptPerMtok);

  let weightNum = 0;
  let weightDen = 0;
  for (const m of paid) {
    if (m.latestTokens && m.latestTokens > 0) {
      weightNum += m.promptUsd! * 1_000_000 * m.latestTokens;
      weightDen += m.latestTokens;
    }
  }
  const usageWeighted = weightDen > 0 ? weightNum / weightDen : null;

  // "Frontier" proxy: the busiest models by recent tokens. Cheapest priced one
  // of those is a good headline "how cheap is the popular frontier" number.
  const topByUsage = [...active]
    .filter((m) => m.latestTokens !== null)
    .sort((a, b) => (b.latestTokens ?? 0) - (a.latestTokens ?? 0))
    .slice(0, 25);
  const frontierPrices = topByUsage
    .map((m) => blendedPerMtok(m.promptUsd, m.completionUsd))
    .filter((v): v is number => v !== null && v > 0);
  const cheapestFrontier = frontierPrices.length ? Math.min(...frontierPrices) : null;

  return {
    totalModels,
    activeModels: active.length,
    freeModels,
    avgPromptUsdPerMtok: avg,
    medianPromptUsdPerMtok: median,
    usageWeightedPromptUsdPerMtok: usageWeighted,
    cheapestFrontierUsdPerMtok: cheapestFrontier,
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}
