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

/**
 * Input share of routed tokens assumed for blended prices. Observed market mix
 * is ~97–99% input (agentic traffic re-sends context every turn), so a 50/50
 * blend badly overweights output price; 90/10 is a conservative round figure.
 */
export const BLEND_PROMPT_SHARE = 0.9;

/** $/Mtok blended across a 90/10 input/output mix (falls back to whichever side exists). */
export function blendedPerMtok(promptUsd: number | null, completionUsd: number | null): number | null {
  if (promptUsd === null && completionUsd === null) return null;
  const p = promptUsd ?? completionUsd ?? 0;
  const c = completionUsd ?? promptUsd ?? 0;
  return (p * BLEND_PROMPT_SHARE + c * (1 - BLEND_PROMPT_SHARE)) * 1_000_000;
}

/**
 * Effective $/token per permaslug, used to price the weekly "model race" by
 * estimated spend (weekly tokens × rate). Prefers the model's observed
 * effective rate (latest daily est. spend ÷ latest daily tokens — this embeds
 * the real prompt/completion mix), falling back to the 90/10 blended list
 * price. Free models are skipped: their $0 must not price a paid permaslug —
 * the weekly `:free` variant keys are zero-spend by definition instead.
 * When several catalog models share a permaslug, the busiest one wins.
 */
export function buildRateByPermaslug(models: ModelWithLatest[]): Record<string, number> {
  const best = new Map<string, { rate: number; score: number }>();
  for (const m of models) {
    const slug = m.permaslug ?? m.canonicalSlug;
    if (!slug || m.isFree) continue;
    const rate = effectiveRate(m);
    if (rate === null) continue;
    const score = m.latestTokens ?? 0;
    const prev = best.get(slug);
    if (!prev || score > prev.score) best.set(slug, { rate, score });
  }
  return Object.fromEntries([...best.entries()].map(([slug, v]) => [slug, v.rate]));
}

/**
 * Effective $/token for one model: observed rate (latest daily est. spend ÷
 * latest daily tokens, which embeds the real prompt/completion mix) with the
 * 90/10 blended list price as fallback. Null when the model can't be priced.
 */
export function effectiveRate(m: ModelWithLatest): number | null {
  let rate: number | null = null;
  if (m.latestSpendUsd !== null && m.latestTokens !== null && m.latestTokens > 0) {
    rate = m.latestSpendUsd / m.latestTokens;
  } else {
    const blended = blendedPerMtok(m.promptUsd, m.completionUsd);
    if (blended !== null) rate = blended / 1_000_000;
  }
  if (rate === null || !Number.isFinite(rate) || rate < 0) return null;
  return rate;
}

export interface ModelTopApps {
  modelId: string;
  /** Effective $/token used to price this model's app tokens. */
  rate: number;
  apps: { appId: number | null; title: string; url: string | null; tokens: number | null }[];
}

export interface AppSpendRow {
  appId: number | null;
  title: string;
  url: string | null;
  /** Est. spend across the swept models, trailing-month window. */
  spendUsd: number;
  /** Tokens counted toward the estimate (swept paid models only). */
  tokens: number;
  /** Top contributing model ids by spend, largest first. */
  topModels: string[];
}

/**
 * Per-app spend estimate assembled from per-model app leaderboards
 * (OpenRouter's `top-apps-for-model`: top ~5 apps per model, trailing ~month).
 * OpenRouter publishes no direct per-app spend, so each app's tokens on each
 * swept model are priced at that model's effective rate and summed. Apps that
 * never crack a swept model's top-5 are undercounted — this ranks the head of
 * the market, not the tail.
 */
export function aggregateAppSpend(perModel: ModelTopApps[]): AppSpendRow[] {
  const byApp = new Map<string, AppSpendRow & { modelSpend: Map<string, number> }>();
  for (const m of perModel) {
    if (!Number.isFinite(m.rate) || m.rate < 0) continue;
    for (const app of m.apps) {
      if (app.tokens === null || app.tokens <= 0) continue;
      const key = app.appId !== null ? `id:${app.appId}` : `title:${app.title}`;
      let row = byApp.get(key);
      if (!row) {
        row = { appId: app.appId, title: app.title, url: app.url, spendUsd: 0, tokens: 0, topModels: [], modelSpend: new Map() };
        byApp.set(key, row);
      }
      const spend = app.tokens * m.rate;
      row.spendUsd += spend;
      row.tokens += app.tokens;
      row.modelSpend.set(m.modelId, (row.modelSpend.get(m.modelId) ?? 0) + spend);
    }
  }
  return [...byApp.values()]
    .map(({ modelSpend, ...row }) => ({
      ...row,
      topModels: [...modelSpend.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id),
    }))
    .sort((a, b) => b.spendUsd - a.spendUsd);
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
