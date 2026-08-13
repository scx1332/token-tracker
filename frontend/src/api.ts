// Typed client for the token-tracker backend (served under /api by nginx).

export interface ModelWithLatest {
  modelId: string;
  canonicalSlug: string | null;
  permaslug: string | null;
  promotionText: string | null;
  name: string;
  author: string;
  variant: string | null;
  description: string | null;
  contextLength: number | null;
  modality: string | null;
  inputModalities: string[] | null;
  outputModalities: string[] | null;
  tokenizer: string | null;
  huggingFaceId: string | null;
  supportedParameters: string[] | null;
  isModerated: boolean | null;
  createdOr: string | null;
  knowledgeCutoff: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  isActive: boolean;
  promptUsd: number | null;
  completionUsd: number | null;
  requestUsd: number | null;
  imageUsd: number | null;
  isFree: boolean;
  priceObservedAt: string | null;
  latestTokens: number | null;
  latestSpendUsd: number | null;
  latestUsageDate: string | null;
  providerCount: number;
}

export interface PriceIndexPoint {
  date: string;
  weightedUsdPerMtok: number | null;
  medianUsdPerMtok: number | null;
}

export interface MarketRow {
  capturedAt: string;
  totalModels: number;
  activeModels: number;
  freeModels: number;
  totalDailyTokens: number | null;
  totalEstimatedDailySpendUsd: number | null;
  avgPromptUsdPerMtok: number | null;
  medianPromptUsdPerMtok: number | null;
  usageWeightedPromptUsdPerMtok: number | null;
  cheapestFrontierUsdPerMtok: number | null;
}

export interface UsageSeriesPoint {
  bucketDate: string;
  totalTokens: number | null;
  totalSpendUsd: number | null;
  modelCount: number;
}

export interface TopModel {
  modelId: string;
  name: string;
  author: string;
  tokens: number | null;
  spendUsd: number | null;
  bucketDate: string;
}

export interface AppUsage {
  appId: number | null;
  title: string;
  url: string | null;
  tokens: number | null;
  requests: number | null;
  rank: number | null;
}

export interface AppSpendRow {
  appId: number | null;
  title: string;
  url: string | null;
  spendUsd: number;
  tokens: number;
  topModels: string[];
}

export interface WeeklyPoint {
  date: string;
  tokensByPermaslug: Record<string, number>;
}

export interface RacePoint {
  date: string;
  spendByModel: Record<string, number>;
  tokensByModel: Record<string, number>;
}

export interface MarketResponse {
  latest: MarketRow | null;
  series: UsageSeriesPoint[];
  priceIndex: PriceIndexPoint[];
  topModels: TopModel[];
  apps: { day: AppUsage[]; week: AppUsage[]; month: AppUsage[] };
  /** Est. per-app spend (tokens priced per model) — null until first ingest. */
  appsSpend: {
    updatedAt: string;
    windowDays: number;
    modelsSwept: number;
    apps: AppSpendRow[];
  } | null;
  weekly: { points: WeeklyPoint[]; updatedAt?: string };
  /** Full-week per-model spend/tokens from our own daily snapshots. */
  race: { points: RacePoint[] };
  /** Effective $/token per permaslug — prices the weekly race by est. spend. */
  ratesByPermaslug?: Record<string, number>;
}

export interface PriceHistoryRow {
  provider: string;
  observedAt: string;
  promptUsd: number | null;
  completionUsd: number | null;
  requestUsd: number | null;
  imageUsd: number | null;
  webSearchUsd: number | null;
  internalReasoningUsd: number | null;
  cacheReadUsd: number | null;
  cacheWriteUsd: number | null;
  contextLength: number | null;
  quantization: string | null;
  isFree: boolean;
}

export interface UsageRow {
  modelId: string;
  provider: string;
  bucketDate: string;
  tokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  requests: number | null;
  estimatedSpendUsd: number | null;
  reasoningTokens: number | null;
}

export interface ModelDetail {
  model: ModelWithLatest & { raw?: unknown };
  priceHistory: PriceHistoryRow[];
  providerPrices: PriceHistoryRow[];
  usage: UsageRow[];
}

export interface ProviderVolumeRow {
  provider: string;
  requestCount: number;
  p50Throughput: number | null;
  p50Latency: number | null;
}

export interface ProviderVolumeResponse {
  model: string;
  /** Trailing window the request counts cover (≈30 min). */
  windowMinutes: number | null;
  providers: ProviderVolumeRow[];
}

export interface ProviderPricesResponse {
  model: string;
  providers: string[];
  points: PriceHistoryRow[];
}

export interface ProviderRevenuePoint {
  provider: string;
  bucketDate: string;
  spendUsd: number | null;
  tokens: number | null;
  models: number;
}

export interface ProviderModelTotal {
  provider: string;
  modelId: string;
  name: string;
  spendUsd: number | null;
  tokens: number | null;
}

export interface ProvidersMarketResponse {
  series: ProviderRevenuePoint[];
  models: ProviderModelTotal[];
}

export interface ProviderStat {
  provider: string;
  modelCount: number;
  cheapestUsdPerMtok: number | null;
  avgUsdPerMtok: number | null;
}

/** One hourly price band for a GPU on the vast.ai rental market, USD/GPU-hour. */
export interface GpuPriceRow {
  gpuName: string;
  capturedAt: string;
  offers: number;
  gpusAvailable: number;
  minUsd: number | null;
  p25Usd: number | null;
  medianUsd: number | null;
  p75Usd: number | null;
  maxUsd: number | null;
  meanUsd: number | null;
  supplyWeightedUsd: number | null;
  minBidUsd: number | null;
  verifiedOffers: number;
  verifiedGpusAvailable: number;
  verifiedMinUsd: number | null;
  verifiedMedianUsd: number | null;
}

export type AcceleratorTier = "flagship" | "datacenter" | "prosumer";

export interface Accelerator {
  name: string;
  label: string;
  tier: AcceleratorTier;
  vramGb: number;
}

export interface AcceleratorWithLatest extends Accelerator {
  latest: GpuPriceRow | null;
}

export interface HealthResponse {
  ok: boolean;
  serverTimeUtc: string;
  build: { commit: string | null; builtAtUtc: string | null };
  models: { total: number; active: number };
  coverage: {
    usageDateMin: string | null;
    usageDateMax: string | null;
    usageDays: number;
    pricePoints: number;
    marketSnapshots: number;
    lastUsageCapturedAt: string | null;
  };
  ingest: {
    status: string;
    startedAt: string;
    finishedAt: string | null;
    priceChanges: number | null;
    usageRows: number | null;
    ageSeconds: number | null;
  } | null;
  database: { totalSizeBytes: string; tables: { tableName: string; rowCount: string }[] } | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => get<HealthResponse>("/health"),
  market: (days = 120) => get<MarketResponse>(`/market?days=${days}`),
  models: (params: { search?: string; author?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.search) q.set("search", params.search);
    if (params.author) q.set("author", params.author);
    if (params.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return get<{ count: number; models: ModelWithLatest[] }>(`/models${qs ? `?${qs}` : ""}`);
  },
  featured: (limit = 16) => get<{ models: ModelWithLatest[] }>(`/models/featured?limit=${limit}`),
  model: (id: string, days = 180) => get<ModelDetail>(`/model?id=${encodeURIComponent(id)}&days=${days}`),
  providerPrices: (id: string, days = 365) =>
    get<ProviderPricesResponse>(`/model/provider-prices?id=${encodeURIComponent(id)}&days=${days}`),
  providerVolume: (id: string) => get<ProviderVolumeResponse>(`/model/provider-volume?id=${encodeURIComponent(id)}`),
  providers: () => get<{ providers: ProviderStat[] }>("/providers"),
  providersMarket: (days = 90) => get<ProvidersMarketResponse>(`/providers/market?days=${days}`),
  gpu: () => get<{ accelerators: AcceleratorWithLatest[] }>("/gpu"),
  gpuSeries: (params: { gpu?: string; days?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.gpu) q.set("gpu", params.gpu);
    q.set("days", String(params.days ?? 30));
    return get<{ series: GpuPriceRow[]; accelerators: Accelerator[] }>(`/gpu/series?${q.toString()}`);
  },
};
