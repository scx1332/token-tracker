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

export interface WeeklyPoint {
  date: string;
  tokensByPermaslug: Record<string, number>;
}

export interface MarketResponse {
  latest: MarketRow | null;
  series: UsageSeriesPoint[];
  snapshots: MarketRow[];
  topModels: TopModel[];
  apps: { day: AppUsage[]; week: AppUsage[]; month: AppUsage[] };
  weekly: { points: WeeklyPoint[]; updatedAt?: string };
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
}

export interface ModelDetail {
  model: ModelWithLatest & { raw?: unknown };
  priceHistory: PriceHistoryRow[];
  providerPrices: PriceHistoryRow[];
  usage: UsageRow[];
}

export interface ProviderStat {
  provider: string;
  modelCount: number;
  cheapestUsdPerMtok: number | null;
  avgUsdPerMtok: number | null;
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
  providers: () => get<{ providers: ProviderStat[] }>("/providers"),
};
