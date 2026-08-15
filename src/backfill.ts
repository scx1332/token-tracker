// Historical backfill of per-model daily token usage.
//
// The hourly `rankings/models?view=day` pass only records the latest complete
// day. To seed deeper history (so charts aren't empty on day one) we use
// `provider-token-chart`, which returns ~90 daily points per model+provider,
// summed across each model's providers. Writes are gap-fills (ON CONFLICT DO
// NOTHING) so they never clobber the more accurate rankings rows.

import { parseIngestConfig, HelpRequested, type IngestConfig } from "./config";
import { OpenRouterClient, modelVariant } from "./openrouter";
import { Storage, type UsageUpsert } from "./storage";
import { fetchEffectivePricing, fetchProviderTokenChart, fetchWeeklyChart, collapseProviderEndpoints } from "./usage";
import { estimateSpendUsd } from "./pricing";
import { isFrontier } from "./frontier";
import { mapPool } from "./concurrency";

const MAX_TARGETS = 80;
const MAX_PROVIDERS_PER_MODEL = 8;

export interface BackfillDeps {
  storage: Storage;
  client: OpenRouterClient;
  config: IngestConfig;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export interface BackfillResult {
  models: number;
  rows: number;
}

/** Backfill deep daily usage history for the busiest + curated-frontier models. */
export async function runBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  const { storage, client, config, signal } = deps;
  const log = deps.log ?? (() => {});

  const models = await storage.getModelsWithLatest({ activeOnly: true });
  if (models.length === 0) {
    log("no models in DB yet — run an ingest pass first");
    return { models: 0, rows: 0 };
  }

  const byUsage = [...models].sort((a, b) => (b.latestTokens ?? 0) - (a.latestTokens ?? 0));
  const targetIds = new Set<string>(byUsage.slice(0, MAX_TARGETS).map((m) => m.modelId));
  for (const m of models) if (isFrontier(m.modelId)) targetIds.add(m.modelId);
  const targets = models.filter((m) => targetIds.has(m.modelId) && m.permaslug);
  const cutoff = daysAgoDate(config.backfillDays);
  log(`backfilling up to ${config.backfillDays}d for ${targets.length} models`);

  let totalRows = 0;
  let processed = 0;

  // Process models in parallel; providers of a model fetched with a small inner
  // pool so total in-flight requests stay bounded (outer × inner).
  const perModel = await mapPool(
    targets,
    Math.max(2, Math.min(config.concurrency, 6)),
    async (model) => {
      if (signal?.aborted) return 0;
      const variant = modelVariant(model.modelId) ?? "standard";
      const permaslug = model.permaslug!;
      const eff = await fetchEffectivePricing(client, permaslug, variant, signal);
      // Endpoints first, or a provider with two endpoints (Anthropic's Vertex
      // and Bedrock regions) gets its token chart fetched — and summed — twice.
      const providers = collapseProviderEndpoints((eff?.providers ?? []).filter((p) => p.slug))
        .sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0))
        .slice(0, MAX_PROVIDERS_PER_MODEL);

      const byDate = new Map<string, number>();
      const charts = await mapPool(providers, 2, (p) =>
        fetchProviderTokenChart(client, permaslug, variant, p.slug, signal),
      );
      for (const chart of charts) {
        for (const point of chart) {
          if (point.date < cutoff) continue;
          byDate.set(point.date, (byDate.get(point.date) ?? 0) + point.tokens);
        }
      }

      const rows: UsageUpsert[] = [];
      for (const [date, tokens] of byDate) {
        rows.push({
          modelId: model.modelId,
          provider: "",
          bucketDate: date,
          tokens,
          promptTokens: null,
          completionTokens: null,
          requests: null,
          estimatedSpendUsd: estimateSpendUsd({ totalTokens: tokens, promptUsd: model.promptUsd, completionUsd: model.completionUsd }),
          source: "provider-token-chart",
        });
      }
      const inserted = await storage.upsertUsageBatch(rows, { onConflict: "ignore" });
      processed += 1;
      if (processed % 15 === 0) log(`  ${processed}/${targets.length} models processed`);
      return inserted;
    },
    { delayMs: config.requestDelayMs, ...(signal ? { signal } : {}) },
  );
  totalRows = perModel.reduce((a, b) => a + (b ?? 0), 0);

  // Weekly headline chart (1yr, top-10) for the dashboard.
  try {
    const weekly = await fetchWeeklyChart(client, signal);
    await storage.setState("weekly_chart", JSON.stringify({ updatedAt: new Date().toISOString(), points: weekly }));
    log(`stored weekly chart (${weekly.length} points)`);
  } catch (error) {
    log(`weekly chart failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  log(`done: ${totalRows} historical usage rows across ${processed} models`);
  return { models: processed, rows: totalRows };
}

function daysAgoDate(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  let config;
  try {
    config = parseIngestConfig(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      console.log(error.message);
      return;
    }
    throw error;
  }

  const storage = await Storage.open(config.databaseUrl);
  const client = new OpenRouterClient(config.baseUrl, config.apiKey);
  const log = (msg: string) => console.log(`[backfill ${new Date().toISOString()}] ${msg}`);
  try {
    await runBackfill({ storage, client, config, log });
  } finally {
    await storage.close();
  }
}

if (import.meta.main) {
  await main();
}
