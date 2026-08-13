// Pure price-series math for the Price Explorer. Given the per-provider price
// change-log for one model, reconstruct the cheapest-provider ("minimum") price
// over time, the min–max spread band, and each provider's own step series.
//
// Prices arrive as USD *per token*; everything here is returned as USD per 1M
// tokens (the unit analysts actually read). Kept dependency-free and pure so it
// can be unit-tested in isolation.

import type { PriceHistoryRow } from "./api";

export type Metric = "blended" | "input" | "output";

/**
 * Input share of routed tokens assumed by the blended price. Observed market
 * traffic is ~97–99% input tokens (agentic loops re-send context every turn),
 * so the industry-conventional 50/50 blend badly overweights output price;
 * 90/10 is a conservative round figure that tracks real cost far better.
 */
export const BLEND_PROMPT_SHARE = 0.9;

export const METRIC_LABEL: Record<Metric, string> = {
  blended: "Blended $/M · 90/10",
  input: "Input $/M",
  output: "Output $/M",
};

/** A price row expressed as USD per 1M tokens for the chosen metric, or null. */
export function metricPerMtok(
  row: { promptUsd: number | null; completionUsd: number | null; isFree?: boolean },
  metric: Metric,
): number | null {
  if (row.isFree) return 0;
  const p = row.promptUsd;
  const c = row.completionUsd;
  if (metric === "input") return p == null ? null : p * 1_000_000;
  if (metric === "output") return c == null ? null : c * 1_000_000;
  if (p == null && c == null) return null;
  const pp = p ?? c ?? 0;
  const cc = c ?? p ?? 0;
  return (pp * BLEND_PROMPT_SHARE + cc * (1 - BLEND_PROMPT_SHARE)) * 1_000_000;
}

export interface EnvelopePoint {
  date: string; // ISO timestamp of the change event
  min: number | null; // cheapest provider's $/M at this time
  max: number | null; // dearest provider's $/M at this time
  cheapest: string | null; // which provider held the minimum
  count: number; // providers quoting at this time
}

/**
 * Reconstruct, at every price-change event, the min / max $/M across all
 * providers that have quoted so far. Each provider is a step function (a quote
 * holds until its next change), so we walk the merged timeline and, at each
 * event, take the extremes of every provider's last-known quote.
 */
export function minEnvelope(points: PriceHistoryRow[], metric: Metric): EnvelopePoint[] {
  const byProvider = groupByProvider(points);
  const times = [...new Set(points.map((p) => p.observedAt))].sort((a, b) => a.localeCompare(b));
  const cursor = new Map<string, number>();
  const lastVal = new Map<string, number | null>();
  for (const prov of byProvider.keys()) {
    cursor.set(prov, 0);
    lastVal.set(prov, null);
  }

  const out: EnvelopePoint[] = [];
  for (const t of times) {
    for (const [prov, rows] of byProvider) {
      let i = cursor.get(prov)!;
      while (i < rows.length && rows[i]!.observedAt <= t) {
        lastVal.set(prov, metricPerMtok(rows[i]!, metric));
        i += 1;
      }
      cursor.set(prov, i);
    }
    let min: number | null = null;
    let max: number | null = null;
    let cheapest: string | null = null;
    let count = 0;
    for (const [prov, v] of lastVal) {
      if (v == null || !Number.isFinite(v)) continue;
      count += 1;
      if (min == null || v < min) {
        min = v;
        cheapest = prov;
      }
      if (max == null || v > max) max = v;
    }
    out.push({ date: t, min, max, cheapest, count });
  }
  return out;
}

export interface ProviderQuote {
  provider: string;
  value: number | null; // latest $/M for the metric
  row: PriceHistoryRow; // latest row (context, quant, free flag …)
}

/** Latest quote per provider, cheapest first — the current "order book". */
export function providerOrderBook(points: PriceHistoryRow[], metric: Metric): ProviderQuote[] {
  const latest = new Map<string, PriceHistoryRow>(); // points are asc → last write wins
  for (const p of points) latest.set(p.provider, p);
  return [...latest.entries()]
    .map(([provider, row]) => ({ provider, value: metricPerMtok(row, metric), row }))
    .sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity));
}

/** One provider's own price change-log, oldest → newest. */
export function seriesForProvider(points: PriceHistoryRow[], provider: string): PriceHistoryRow[] {
  return points
    .filter((p) => p.provider === provider)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
}

export function distinctProviders(points: PriceHistoryRow[]): string[] {
  return [...new Set(points.map((p) => p.provider))].sort((a, b) => a.localeCompare(b));
}

/** Percent change between the first and last defined value of an envelope field. */
export function envelopeChange(env: EnvelopePoint[], field: "min" | "max" = "min"): number | null {
  const vals = env.map((e) => e[field]).filter((v): v is number => v != null && Number.isFinite(v));
  if (vals.length < 2) return null;
  const first = vals[0]!;
  const last = vals[vals.length - 1]!;
  if (first === 0) return null;
  return (last - first) / Math.abs(first);
}

function groupByProvider(points: PriceHistoryRow[]): Map<string, PriceHistoryRow[]> {
  const byProvider = new Map<string, PriceHistoryRow[]>();
  for (const p of points) {
    const arr = byProvider.get(p.provider);
    if (arr) arr.push(p);
    else byProvider.set(p.provider, [p]);
  }
  for (const arr of byProvider.values()) arr.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  return byProvider;
}
