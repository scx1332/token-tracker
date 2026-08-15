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
import {
  fetchRankings,
  fetchWeeklyChart,
  fetchApps,
  fetchTopAppsForModel,
  fetchEndpointStats,
  fetchEffectivePricing,
  fetchProviderTokenChart,
  collapseProviderEndpoints,
} from "./usage";
import { computeMarketAggregates, effectiveRate, aggregateAppSpend, type ModelTopApps } from "./market";
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
  // Effective rates (real paid $/token incl. cache discounts) beat list prices
  // wherever the daily sweep has them; the rest fall back to list.
  const effRates = await storage.getLatestEffectiveRates().catch(() => new Map<string, { inputPerTok: number; outputPerTok: number }>());

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
      const eff = resolved ? effRates.get(resolved) : undefined;
      const spend =
        eff || price
          ? estimateSpendUsd({
              totalTokens: rec.tokens,
              promptTokens: rec.promptTokens,
              completionTokens: rec.completionTokens,
              promptUsd: eff ? eff.inputPerTok : price?.promptUsd ?? null,
              completionUsd: eff ? eff.outputPerTok : price?.completionUsd ?? null,
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
        reasoningTokens: rec.reasoningTokens,
        source: "rankings",
      });
    }
  }

  return storage.upsertUsageBatch([...merged.values()], { onConflict: "update" });
}

/** Store the weekly headline chart and app ranking as JSON blobs for the API. */
async function ingestSideData(deps: IngestDeps): Promise<void> {
  const { client, storage, signal } = deps;
  const [weekly, apps, appSpend] = await Promise.allSettled([
    fetchWeeklyChart(client, signal),
    fetchApps(client, signal),
    ingestAppSpend(deps),
  ]);
  await ingestProviderVolume(deps).catch((e) => deps.log?.(`provider volume: ${errMsg(e)}`));
  await ingestProviderUsage(deps).catch((e) => deps.log?.(`provider usage: ${errMsg(e)}`));
  if (weekly.status === "fulfilled") {
    await storage.setState("weekly_chart", JSON.stringify({ updatedAt: new Date().toISOString(), points: weekly.value }));
  }
  if (apps.status === "fulfilled") {
    await storage.setState("apps_ranking", JSON.stringify({ updatedAt: new Date().toISOString(), ...apps.value }));
  }
  if (appSpend.status === "fulfilled" && appSpend.value) {
    await storage.setState("apps_spend", JSON.stringify(appSpend.value));
  }
}

/** How many top-spend models to sweep for per-app spend (1 request each). */
const APP_SPEND_MODEL_SWEEP = 30;

/**
 * Estimate per-app spend. OpenRouter publishes no per-app dollars, so this
 * sweeps the top paid models by est. spend, pulls each model's top-apps
 * leaderboard (trailing ~month of tokens), prices those tokens at the model's
 * effective rate, and aggregates per app.
 */
async function ingestAppSpend(deps: IngestDeps): Promise<object | null> {
  const { client, storage, signal } = deps;
  const models = await storage.getModelsWithLatest({ activeOnly: true, limit: 5000 });
  const seen = new Set<string>();
  const targets: { modelId: string; permaslug: string; variant: string; rate: number }[] = [];
  for (const m of models) {
    // Already spend-ordered; free models are skipped — they add $0 by definition.
    if (m.isFree || !m.permaslug || (m.latestSpendUsd ?? 0) <= 0) continue;
    const rate = effectiveRate(m);
    if (rate === null) continue;
    const variant = m.variant ?? "standard";
    const key = `${m.permaslug} ${variant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ modelId: m.modelId, permaslug: m.permaslug, variant, rate });
    if (targets.length >= APP_SPEND_MODEL_SWEEP) break;
  }
  if (!targets.length) return null;

  const perModel = await mapPool(
    targets,
    4,
    async (t): Promise<ModelTopApps | null> => {
      try {
        const apps = await fetchTopAppsForModel(client, t.permaslug, t.variant, signal);
        return { modelId: t.modelId, rate: t.rate, apps };
      } catch {
        return null;
      }
    },
    signal ? { delayMs: 150, signal } : { delayMs: 150 },
  );
  const swept = perModel.filter((r): r is ModelTopApps => r !== null);
  if (!swept.length) return null;

  return {
    updatedAt: new Date().toISOString(),
    windowDays: 31,
    modelsSwept: swept.length,
    apps: aggregateAppSpend(swept).slice(0, 30),
  };
}

/** How many models get per-provider volume snapshots each pass (1 request each). */
const PROVIDER_VOLUME_SWEEP = 40;

/**
 * Snapshot per-provider request volume for the models that matter (top by est.
 * spend ∪ top by tokens). OpenRouter serves only the live ~30-min window, so
 * this hourly append is the sole source of provider market-share history.
 */
async function ingestProviderVolume(deps: IngestDeps): Promise<void> {
  const { client, storage, signal } = deps;
  const models = await storage.getModelsWithLatest({ activeOnly: true, limit: 5000 });
  const eligible = models.filter((m) => m.permaslug && (m.latestTokens ?? 0) > 0);
  const byTokens = [...eligible].sort((a, b) => (b.latestTokens ?? 0) - (a.latestTokens ?? 0)).slice(0, 15);

  const seen = new Set<string>();
  const targets: { modelId: string; permaslug: string; variant: string }[] = [];
  // `models` is spend-ordered; big token movers ride along even when cheap.
  for (const m of [...eligible.slice(0, PROVIDER_VOLUME_SWEEP - byTokens.length), ...byTokens]) {
    const variant = m.variant ?? "standard";
    const key = `${m.permaslug} ${variant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ modelId: m.modelId, permaslug: m.permaslug!, variant });
    if (targets.length >= PROVIDER_VOLUME_SWEEP) break;
  }
  if (!targets.length) return;

  const capturedAt = new Date();
  let saved = 0;
  await mapPool(
    targets,
    4,
    async (t) => {
      try {
        const rows = await fetchEndpointStats(client, t.permaslug, t.variant, signal);
        if (rows.length) {
          await storage.insertProviderVolumeSnapshots(t.modelId, rows, capturedAt);
          saved += 1;
        }
      } catch {
        // Best-effort: a missing model's stats never blocks the sweep.
      }
      return null;
    },
    signal ? { delayMs: 150, signal } : { delayMs: 150 },
  );
  deps.log?.(`provider volume: snapshotted ${saved}/${targets.length} models`);
}

/** How many models get the daily per-provider usage + effective-price sweep. */
const PROVIDER_USAGE_SWEEP = 40;
const PROVIDER_USAGE_MAX_PROVIDERS = 8;
const PROVIDER_USAGE_MIN_GAP_MS = 20 * 3600_000;
const PROVIDER_USAGE_STATE_KEY = "provider_usage_last_sweep";

/**
 * Daily sweep: per-provider daily token history (`provider-token-chart`, ~90d
 * dense — self-backfilling) written as provider-keyed usage_snapshots rows,
 * plus usage-weighted effective prices per model & provider appended to
 * effective_price_snapshots. ~9 requests per model, so gated to once a day.
 */
async function ingestProviderUsage(deps: IngestDeps): Promise<void> {
  const { client, storage, signal } = deps;
  const last = await storage.getState(PROVIDER_USAGE_STATE_KEY);
  if (last && Date.now() - new Date(last).getTime() < PROVIDER_USAGE_MIN_GAP_MS) return;

  const models = await storage.getModelsWithLatest({ activeOnly: true, limit: 5000 });
  const eligible = models.filter((m) => m.permaslug && (m.latestTokens ?? 0) > 0);
  const byTokens = [...eligible].sort((a, b) => (b.latestTokens ?? 0) - (a.latestTokens ?? 0)).slice(0, 15);
  const seen = new Set<string>();
  const targets: typeof eligible = [];
  for (const m of [...eligible.slice(0, PROVIDER_USAGE_SWEEP - byTokens.length), ...byTokens]) {
    const key = `${m.permaslug} ${m.variant ?? "standard"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(m);
    if (targets.length >= PROVIDER_USAGE_SWEEP) break;
  }
  if (!targets.length) return;

  const capturedAt = new Date();
  let usageRows = 0;
  let priceRows = 0;
  let repriced = 0;
  await mapPool(
    targets,
    3,
    async (m) => {
      try {
        const variant = m.variant ?? "standard";
        const eff = await fetchEffectivePricing(client, m.permaslug!, variant, signal);
        if (!eff) return null;

        // Endpoints → providers before anything is stored: both tables below are
        // keyed by slug, so a duplicate slug would otherwise overwrite itself.
        const providerRates = collapseProviderEndpoints(eff.providers.filter((p) => p.slug));
        const effRows = [
          { provider: "", effInputPerMtok: eff.weightedInputPerMtok, effOutputPerMtok: eff.weightedOutputPerMtok, totalTokens: null },
          ...providerRates.map((p) => ({ provider: p.slug, effInputPerMtok: p.effInputPerMtok, effOutputPerMtok: p.effOutputPerMtok, totalTokens: p.totalTokens })),
        ];
        await storage.insertEffectivePriceSnapshots(m.modelId, effRows, capturedAt);
        priceRows += effRows.length;

        // Re-price this model's daily history at the effective rates (carry-back:
        // today's real paid rate is the best estimate for past days too).
        if (eff.weightedInputPerMtok !== null && eff.weightedInputPerMtok > 0 && eff.weightedOutputPerMtok !== null) {
          repriced += await storage.repriceUsageSpend(
            m.modelId,
            eff.weightedInputPerMtok / 1_000_000,
            eff.weightedOutputPerMtok / 1_000_000,
          );
        }

        // Per-provider daily tokens, priced at the provider's effective rates
        // blended by the model's own observed prompt/completion mix.
        const promptShare = (await storage.getObservedPromptShare(m.modelId)) ?? 0.9;
        const providers = [...providerRates]
          .sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0))
          .slice(0, PROVIDER_USAGE_MAX_PROVIDERS);
        const perProvider = await mapPool(providers, 2, async (p) => {
          const chart = await fetchProviderTokenChart(client, m.permaslug!, variant, p.slug, signal);
          const rows: UsageUpsert[] = chart.map((point) => ({
            modelId: m.modelId,
            provider: p.slug,
            bucketDate: point.date,
            tokens: point.tokens,
            promptTokens: null,
            completionTokens: null,
            requests: null,
            estimatedSpendUsd: estimateSpendUsd({
              totalTokens: point.tokens,
              promptUsd: p.effInputPerMtok !== null ? p.effInputPerMtok / 1_000_000 : null,
              completionUsd: p.effOutputPerMtok !== null ? p.effOutputPerMtok / 1_000_000 : null,
              promptShare,
            }),
            source: "provider-token-chart",
          }));
          return storage.upsertUsageBatch(rows, { onConflict: "update" });
        });
        usageRows += perProvider.reduce<number>((a, b) => a + (b ?? 0), 0);
      } catch {
        // Best-effort per model.
      }
      return null;
    },
    signal ? { delayMs: 200, signal } : { delayMs: 200 },
  );

  await storage.setState(PROVIDER_USAGE_STATE_KEY, capturedAt.toISOString());
  deps.log?.(
    `provider usage: ${usageRows} daily rows + ${priceRows} effective-price rows across ${targets.length} models; repriced ${repriced} spend rows`,
  );
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
