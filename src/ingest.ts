import type { IngestConfig } from "./config";
import { OpenRouterClient } from "./openrouter";
import {
  Storage,
  priceStateKey,
  type PricePointInsert,
  type UsageUpsert,
} from "./storage";
import { toModelUpsert, buildUsageIndex, resolveUsageModelId } from "./modelMap";
import { normalizePricing, pricingChanged, isFreePricing, estimateSpendUsd } from "./pricing";
import { fetchRankings, fetchWeeklyChart, fetchApps } from "./usage";
import { computeMarketAggregates } from "./market";
import { mapPool } from "./concurrency";
import type { NormalizedPricing, OpenRouterModel } from "./types";

export interface IngestResult {
  modelsSeen: number;
  priceChanges: number;
  usageRows: number;
  deactivated: number;
  errors: string[];
  durationMs: number;
}

export interface IngestDeps {
  storage: Storage;
  client: OpenRouterClient;
  config: IngestConfig;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

type CatalogModel = OpenRouterModel & { canonical_slug?: string; links?: { details?: string } };

/** Run a single full ingestion pass: catalog, prices, usage, and market snapshot. */
export async function runIngestion(deps: IngestDeps): Promise<IngestResult> {
  const { storage, client, config, signal } = deps;
  const log = deps.log ?? (() => {});
  const startedMs = Date.now();
  const errors: string[] = [];
  const runId = await storage.startIngestRun();

  let modelsSeen = 0;
  let priceChanges = 0;
  let usageRows = 0;
  let deactivated = 0;

  try {
    // 1. Catalog + model-level pricing --------------------------------------
    const modelsResp = await client.getModels(signal);
    const models = (modelsResp.data ?? []) as CatalogModel[];
    modelsSeen = models.length;
    log(`fetched ${models.length} models`);

    const promoById = await fetchPromotions(client, signal).catch((e) => {
      errors.push(`promotions: ${errMsg(e)}`);
      return new Map<string, string>();
    });

    const latest = await storage.getLatestPrices();
    const modelPriceById = new Map<string, NormalizedPricing>();
    const seenIds: string[] = [];
    const modelPricePoints: PricePointInsert[] = [];

    for (const model of models) {
      await storage.upsertModel(toModelUpsert(model, { promotionText: promoById.get(model.id) ?? null }));
      seenIds.push(model.id);

      const pricing = normalizePricing(model.pricing);
      modelPriceById.set(model.id, pricing);
      const prev = latest.get(priceStateKey(model.id, ""))?.pricing ?? null;
      if (pricingChanged(prev, pricing)) {
        modelPricePoints.push({
          modelId: model.id,
          provider: "",
          pricing,
          contextLength: model.context_length ?? null,
          quantization: null,
          isFree: isFreePricing(pricing),
          raw: model.pricing ?? null,
        });
      }
    }
    await storage.insertPricePoints(modelPricePoints);
    priceChanges += modelPricePoints.length;
    deactivated = await storage.deactivateMissingModels(seenIds);
    log(`model-level price changes: ${modelPricePoints.length}; deactivated ${deactivated}`);

    // 2. Per-provider pricing (concurrency-limited) -------------------------
    if (config.fetchEndpoints) {
      const providerChanges = await ingestProviderPrices(deps, models, latest);
      priceChanges += providerChanges;
      log(`provider-level price changes: ${providerChanges}`);
    }

    // 3. Usage time series --------------------------------------------------
    if (config.fetchUsage) {
      usageRows = await ingestUsage(deps, models, modelPriceById);
      log(`usage rows upserted: ${usageRows}`);
      await ingestSideData(deps).catch((e) => errors.push(`sidedata: ${errMsg(e)}`));
    }

    // 4. Market snapshot ----------------------------------------------------
    await computeAndStoreMarket(storage, modelsSeen);

    await storage.finishIngestRun(runId, {
      status: "ok",
      modelsSeen,
      priceChanges,
      usageRows,
      durationMs: Date.now() - startedMs,
      error: errors.length ? errors.join("; ").slice(0, 2000) : null,
      notes: { deactivated, warnings: errors },
    });
  } catch (error) {
    const msg = errMsg(error);
    errors.push(msg);
    await storage.finishIngestRun(runId, {
      status: "error",
      modelsSeen,
      priceChanges,
      usageRows,
      durationMs: Date.now() - startedMs,
      error: msg.slice(0, 2000),
    });
    throw error;
  }

  return { modelsSeen, priceChanges, usageRows, deactivated, errors, durationMs: Date.now() - startedMs };
}

/** Fetch per-provider endpoint pricing for each base model, inserting price changes. */
async function ingestProviderPrices(
  deps: IngestDeps,
  models: CatalogModel[],
  latest: Awaited<ReturnType<Storage["getLatestPrices"]>>,
): Promise<number> {
  const { client, storage, config, signal } = deps;
  // Endpoints are per base model; variants (":free"/":batch") and "~" aliases
  // share the same providers, so fetch each base model once.
  const baseModels = models.filter((m) => !m.id.includes(":") && !m.id.startsWith("~"));

  const pointsPerModel = await mapPool(
    baseModels,
    config.concurrency,
    async (model) => {
      const points: PricePointInsert[] = [];
      try {
        const resp = await client.getModelEndpoints(model.links?.details ?? model.id, signal);
        const endpoints = resp.data?.endpoints ?? [];
        for (const endpoint of endpoints) {
          const provider = endpoint.provider_name || endpoint.name || endpoint.tag || "unknown";
          const pricing = normalizePricing(endpoint.pricing);
          const prev = latest.get(priceStateKey(model.id, provider))?.pricing ?? null;
          if (pricingChanged(prev, pricing)) {
            points.push({
              modelId: model.id,
              provider,
              pricing,
              contextLength: endpoint.context_length ?? null,
              quantization: endpoint.quantization ?? null,
              isFree: isFreePricing(pricing),
              raw: endpoint,
            });
          }
        }
      } catch (error) {
        deps.log?.(`endpoints ${model.id}: ${errMsg(error)}`);
      }
      return points;
    },
    { delayMs: config.requestDelayMs, ...(signal ? { signal } : {}) },
  );

  const allPoints = pointsPerModel.flat();
  await storage.insertPricePoints(allPoints);
  return allPoints.length;
}

/** Fetch daily usage and upsert per-model rows with accurately priced spend. */
async function ingestUsage(
  deps: IngestDeps,
  models: CatalogModel[],
  modelPriceById: Map<string, NormalizedPricing>,
): Promise<number> {
  const { client, storage, signal } = deps;
  const index = buildUsageIndex(models);

  // `view=day` returns every active model for the latest complete day. `week`/
  // `month` are NOT dense daily series (they add only a sparse tail), so deep
  // per-model history comes from the provider-token-chart backfill instead.
  const views: ("day")[] = ["day"];
  const merged = new Map<string, UsageUpsert>();

  for (const view of views) {
    let records;
    try {
      records = await fetchRankings(client, view, signal);
    } catch (error) {
      deps.log?.(`rankings ${view}: ${errMsg(error)}`);
      continue;
    }
    for (const rec of records) {
      const resolved = resolveUsageModelId(index, rec.permaslug, rec.variant);
      const modelId = resolved ?? syntheticId(rec.permaslug, rec.variant);
      const price = resolved ? modelPriceById.get(resolved) : undefined;
      const spend = price
        ? estimateSpendUsd({
            totalTokens: rec.tokens,
            promptTokens: rec.promptTokens,
            completionTokens: rec.completionTokens,
            promptUsd: price.promptUsd,
            completionUsd: price.completionUsd,
          })
        : null;
      merged.set(`${modelId}|${rec.date}`, {
        modelId,
        provider: "",
        bucketDate: rec.date,
        tokens: rec.tokens,
        promptTokens: rec.promptTokens,
        completionTokens: rec.completionTokens,
        requests: rec.requests,
        estimatedSpendUsd: spend,
        source: "rankings",
      });
    }
  }

  return storage.upsertUsageBatch([...merged.values()], { onConflict: "update" });
}

/** Store the weekly headline chart and app ranking as JSON blobs for the API. */
async function ingestSideData(deps: IngestDeps): Promise<void> {
  const { client, storage, signal } = deps;
  const [weekly, apps] = await Promise.allSettled([
    fetchWeeklyChart(client, signal),
    fetchApps(client, signal),
  ]);
  if (weekly.status === "fulfilled") {
    await storage.setState("weekly_chart", JSON.stringify({ updatedAt: new Date().toISOString(), points: weekly.value }));
  }
  if (apps.status === "fulfilled") {
    await storage.setState("apps_ranking", JSON.stringify({ updatedAt: new Date().toISOString(), ...apps.value }));
  }
}

/** Compute market-wide aggregates + latest-day totals and store one snapshot. */
export async function computeAndStoreMarket(storage: Storage, totalModels: number): Promise<void> {
  const models = await storage.getModelsWithLatest({ activeOnly: true });
  const aggregates = computeMarketAggregates(models, totalModels);
  const series = await storage.getMarketUsageSeries({ since: daysAgo(35) });
  const latestDay = series.at(-1);

  await storage.insertMarketSnapshot({
    capturedAt: new Date(),
    ...aggregates,
    totalDailyTokens: latestDay?.totalTokens ?? null,
    totalEstimatedDailySpendUsd: latestDay?.totalSpendUsd ?? null,
    raw: { latestDay: latestDay ?? null },
  });
}

async function fetchPromotions(client: OpenRouterClient, signal?: AbortSignal): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const raw = await client.getFrontendJson<any>("/api/frontend/v1/models/find", signal);
  const list = raw?.data?.models;
  if (Array.isArray(list)) {
    for (const m of list) {
      if (m?.slug && m?.promotion_message) map.set(m.slug, String(m.promotion_message));
    }
  }
  return map;
}

function syntheticId(permaslug: string, variant: string): string {
  return variant === "standard" ? permaslug : `${permaslug}:${variant}`;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
