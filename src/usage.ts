// Fetch + normalize OpenRouter usage/ranking analytics.
//
// Join keys: everything in the frontend analytics API is keyed by `permaslug`
// (== a catalog model's `canonical_slug`) plus a `variant` (standard|free|batch|
// thinking). Records carry prompt and completion token counts separately, so
// spend can be priced accurately rather than blended.

import type { OpenRouterClient } from "./openrouter";

export interface RawUsageRecord {
  permaslug: string;
  variant: string;
  date: string; // YYYY-MM-DD (UTC)
  promptTokens: number | null;
  completionTokens: number | null;
  tokens: number | null;
  reasoningTokens: number | null;
  requests: number | null;
}

export interface AppUsage {
  appId: number | null;
  title: string;
  url: string | null;
  tokens: number | null;
  requests: number | null;
  rank: number | null;
}

export interface EndpointVolumeRow {
  provider: string;
  requestCount: number;
  windowMinutes: number | null;
  p50Throughput: number | null;
  p50Latency: number | null;
}

/**
 * Parse `stats/endpoint` into per-provider volume rows. Request counts cover a
 * trailing ~30-minute window — the only public per-provider volume signal.
 * One provider can run several endpoints (regions/quantizations): counts are
 * summed, the busiest endpoint's latency/throughput kept.
 */
export function parseEndpointStats(raw: unknown): EndpointVolumeRow[] {
  const data = (raw as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const byProvider = new Map<string, EndpointVolumeRow & { top: number }>();
  for (const ep of data as any[]) {
    const name = ep?.provider_display_name ?? ep?.provider_name;
    const stats = ep?.stats;
    if (!name || !stats) continue;
    const count = Number(stats.request_count ?? 0);
    if (!Number.isFinite(count) || count < 0) continue;
    const cur =
      byProvider.get(name) ??
      ({ provider: String(name), requestCount: 0, windowMinutes: null, p50Throughput: null, p50Latency: null, top: -1 });
    cur.requestCount += count;
    cur.windowMinutes = cur.windowMinutes ?? toNum(stats.window_minutes);
    if (count > cur.top) {
      cur.top = count;
      cur.p50Throughput = toNum(stats.p50_throughput);
      cur.p50Latency = toNum(stats.p50_latency);
    }
    byProvider.set(name, cur);
  }
  return [...byProvider.values()]
    .map(({ top: _top, ...row }) => row)
    .sort((a, b) => b.requestCount - a.requestCount);
}

/** Live per-provider request volume for one model (`stats/endpoint`). */
export async function fetchEndpointStats(
  client: OpenRouterClient,
  permaslug: string,
  variant: string,
  signal?: AbortSignal,
): Promise<EndpointVolumeRow[]> {
  const raw = await client.getFrontendJson(
    `/api/frontend/v1/stats/endpoint?permaslug=${encodeURIComponent(permaslug)}&variant=${encodeURIComponent(variant)}`,
    signal,
  );
  return parseEndpointStats(raw);
}

export interface EffectivePricing {
  weightedInputPerMtok: number | null;
  weightedOutputPerMtok: number | null;
  providers: { slug: string; name: string; totalTokens: number | null; effInputPerMtok: number | null; effOutputPerMtok: number | null }[];
}

function toDate(value: unknown): string {
  return String(value ?? "").slice(0, 10);
}

function toNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Parse the flat `rankings/models` array into normalized daily usage records. */
export function parseRankingsRecords(raw: unknown): RawUsageRecord[] {
  const data = Array.isArray(raw) ? raw : (raw as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: RawUsageRecord[] = [];
  for (const r of data as any[]) {
    const permaslug = r?.model_permaslug;
    if (!permaslug) continue;
    const prompt = toNum(r.total_prompt_tokens);
    const completion = toNum(r.total_completion_tokens);
    const tokens = prompt === null && completion === null ? null : (prompt ?? 0) + (completion ?? 0);
    out.push({
      permaslug,
      variant: r.variant ?? "standard",
      date: toDate(r.date),
      promptTokens: prompt,
      completionTokens: completion,
      tokens,
      reasoningTokens: toNum(r.total_native_tokens_reasoning),
      requests: toNum(r.count),
    });
  }
  return out;
}

/**
 * Fetch daily usage from `rankings/models`.
 * `day` = all models for the latest complete day; `week`/`month` = a daily
 * series (7 / ~20 days) for the busiest models.
 */
export async function fetchRankings(
  client: OpenRouterClient,
  view: "day" | "week" | "month",
  signal?: AbortSignal,
): Promise<RawUsageRecord[]> {
  const raw = await client.getFrontendJson(`/api/frontend/v1/rankings/models?view=${view}`, signal);
  return parseRankingsRecords(raw);
}

export interface WeeklyChartPoint {
  date: string;
  tokensByPermaslug: Record<string, number>;
}

/** Headline weekly token series (~1 year, top-10 models) that powers /rankings. */
export async function fetchWeeklyChart(client: OpenRouterClient, signal?: AbortSignal): Promise<WeeklyChartPoint[]> {
  const raw = await client.getFrontendJson<any>("/api/frontend/v1/rankings/model-rankings-chart", signal);
  const points = raw?.data?.data;
  if (!Array.isArray(points)) return [];
  return points.map((p: any) => ({
    date: toDate(p.x),
    tokensByPermaslug: (p.ys ?? {}) as Record<string, number>,
  }));
}

/** Public apps ranked by token volume (day/week/month buckets). */
export async function fetchApps(
  client: OpenRouterClient,
  signal?: AbortSignal,
): Promise<{ day: AppUsage[]; week: AppUsage[]; month: AppUsage[] }> {
  const raw = await client.getFrontendJson<any>("/api/frontend/v1/rankings/apps", signal);
  const data = raw?.data ?? {};
  return { day: parseAppList(data.day), week: parseAppList(data.week), month: parseAppList(data.month) };
}

function parseAppList(list: unknown): AppUsage[] {
  return Array.isArray(list)
    ? list.map((r: any) => ({
        appId: toNum(r.app_id),
        title: r.app?.title ?? r.app?.slug ?? "Unknown app",
        url: r.app?.main_url ?? r.app?.origin_url ?? null,
        tokens: toNum(r.total_tokens),
        requests: toNum(r.total_requests),
        rank: toNum(r.rank),
      }))
    : [];
}

/**
 * Top ~5 apps routing one model, trailing ~month window (shorter for models
 * newer than that — totals cover the model's whole chart window).
 */
export async function fetchTopAppsForModel(
  client: OpenRouterClient,
  permaslug: string,
  variant: string,
  signal?: AbortSignal,
): Promise<AppUsage[]> {
  const raw = await client.getFrontendJson<any>(
    `/api/frontend/v1/stats/top-apps-for-model?permaslug=${encodeURIComponent(permaslug)}&variant=${encodeURIComponent(variant)}`,
    signal,
  );
  return parseAppList(raw?.data?.top_apps);
}

/** Usage-weighted effective prices ($/Mtok) and the provider list for a model. */
export async function fetchEffectivePricing(
  client: OpenRouterClient,
  permaslug: string,
  variant: string,
  signal?: AbortSignal,
): Promise<EffectivePricing | null> {
  try {
    const raw = await client.getFrontendJson<any>(
      `/api/frontend/v1/stats/effective-pricing?permaslug=${encodeURIComponent(permaslug)}&variant=${encodeURIComponent(variant)}`,
      signal,
    );
    const d = raw?.data;
    if (!d) return null;
    return {
      weightedInputPerMtok: toNum(d.weightedInputPrice),
      weightedOutputPerMtok: toNum(d.weightedOutputPrice),
      providers: Array.isArray(d.providerSummaries)
        ? d.providerSummaries.map((s: any) => ({
            slug: s.providerSlug ?? s.providerName ?? "",
            name: s.providerName ?? s.providerSlug ?? "",
            totalTokens: toNum(s.totalTokens),
            effInputPerMtok: toNum(s.effectiveInputPrice),
            effOutputPerMtok: toNum(s.effectiveOutputPrice),
          }))
        : [],
    };
  } catch {
    return null;
  }
}

/** Dense daily token throughput (~90d) for one model on one provider. */
export async function fetchProviderTokenChart(
  client: OpenRouterClient,
  permaslug: string,
  variant: string,
  provider: string,
  signal?: AbortSignal,
): Promise<{ date: string; tokens: number }[]> {
  try {
    const raw = await client.getFrontendJson<any>(
      `/api/frontend/v1/stats/provider-token-chart?permaslug=${encodeURIComponent(permaslug)}&variant=${encodeURIComponent(variant)}&provider=${encodeURIComponent(provider)}`,
      signal,
    );
    const chart = raw?.data?.chartData;
    if (!Array.isArray(chart)) return [];
    const out: { date: string; tokens: number }[] = [];
    for (const point of chart) {
      const date = toDate(point.x);
      const ys = point.ys ?? {};
      let tokens = 0;
      for (const value of Object.values(ys)) {
        const n = toNum(value);
        if (n !== null) tokens += n;
      }
      out.push({ date, tokens });
    }
    return out;
  } catch {
    return [];
  }
}
