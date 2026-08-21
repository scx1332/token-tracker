import { Storage } from "./storage";
import { readBuildInfo } from "./buildInfo";
import { isFrontier } from "./frontier";
import { ACCELERATORS } from "./accelerators";
import { buildRateByPermaslug } from "./market";
import { fetchJson } from "./scraper";
import { parseEndpointStats } from "./usage";
import { bearerToken, pickLatestBackup, secretEquals } from "./backup";
import { evaluateChecks, overallStatus, type BackupFact, type MonitorFacts } from "./monitor";
import { readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

export interface ServerOptions {
  port: number;
  hostname?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function sinceFromParams(params: URLSearchParams, defaultDays: number): string {
  const daysRaw = params.get("days");
  const days = daysRaw && /^\d+$/.test(daysRaw) ? Math.min(Number(daysRaw), 800) : defaultDays;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Token stats exclude free-model traffic unless the caller opts back in. */
function excludeFreeFromParams(params: URLSearchParams): boolean {
  return params.get("includeFree") !== "true";
}

/** Race window: ~13 full weeks of our own daily snapshots (coverage is ~90d). */
const RACE_DAYS = 13 * 7;
function raceSince(days = RACE_DAYS): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function limitFromParams(params: URLSearchParams, def: number, max: number): number {
  const raw = params.get("limit");
  if (raw && /^\d+$/.test(raw)) return Math.min(Number(raw), max);
  return def;
}

const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai";
const VOLUME_CACHE_MS = 10 * 60_000;

// Where `scripts/backup-db.sh` drops archives, mounted read-only into this
// container. The endpoint that serves them stays off — 404, as if it were never
// routed — unless BACKUP_TOKEN is set, so it exists only where it is wanted.
const BACKUP_DIR = process.env.BACKUP_DIR ?? "/backups";
const BACKUP_TOKEN = process.env.BACKUP_TOKEN ?? "";

export function createServer(storage: Storage, options: ServerOptions) {
  const build = readBuildInfo();
  const volumeCache = new Map<string, { at: number; body: unknown }>();

  async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const q = url.searchParams;

    switch (path) {
      case "/":
      case "/health":
        return handleHealth();
      case "/status":
        return handleStatus();
      case "/market":
        return handleMarket(q);
      case "/market/series":
        return json({
          series: await storage.getMarketUsageSeries({ since: sinceFromParams(q, 120), excludeFree: excludeFreeFromParams(q) }),
        });
      case "/market/snapshots":
        return json({ snapshots: await storage.getMarketSnapshots({ since: sinceFromParams(q, 120) }) });
      case "/market/race":
        return handleRace(q);
      case "/models":
        return handleModels(q);
      case "/models/featured":
        return handleFeatured(q);
      case "/model":
        return handleModel(q);
      case "/model/provider-prices":
        return handleProviderPrices(q);
      case "/model/provider-volume":
        return handleProviderVolume(q);
      case "/model/provider-volume/history":
        return handleProviderVolumeHistory(q);
      case "/model/effective-prices":
        return handleEffectivePrices(q);
      case "/prices":
        return handlePrices(q);
      case "/usage":
        return handleUsage(q);
      case "/providers":
        return json({ providers: await storage.getProviderStats() });
      case "/providers/revenue":
        return json({ series: await storage.getProviderRevenueSeries({ since: sinceFromParams(q, 90) }) });
      case "/providers/market": {
        const since = sinceFromParams(q, 90);
        const [series, models] = await Promise.all([
          storage.getProviderRevenueSeries({ since }),
          storage.getProviderModelTotals({ since }),
        ]);
        return json({ series, models });
      }
      case "/gpu":
        return handleGpuLatest();
      case "/gpu/series":
        return handleGpuSeries(q);
      case "/gpu/daily":
        return handleGpuDaily(q);
      case "/apps":
        return handleKvJson("apps_ranking", { day: [], week: [], month: [] });
      case "/usage/weekly":
        return handleKvJson("weekly_chart", { points: [] });
      case "/backup/latest":
        return handleBackupLatest(req);
      default:
        return json({ error: `Not found: ${path}` }, 404);
    }
  }

  /**
   * The newest database backup, for the GitHub Action that verifies it by
   * restoring it into a clean stack. Bearer-token gated; the token buys nothing
   * else, and the archive holds only public market data (no keys are stored in
   * the database), so a leak costs a dataset, not an account.
   */
  async function handleBackupLatest(req: Request): Promise<Response> {
    if (!BACKUP_TOKEN) return json({ error: "Not found: /backup/latest" }, 404);
    if (!secretEquals(bearerToken(req.headers.get("authorization")), BACKUP_TOKEN)) {
      return json({ error: "Unauthorized" }, 401);
    }

    const names = await readdir(BACKUP_DIR).catch(() => null);
    if (!names) return json({ error: "Backup directory is not mounted" }, 503);
    const name = pickLatestBackup(names);
    if (!name) return json({ error: "No backup archive yet" }, 503);

    const file = Bun.file(`${BACKUP_DIR}/${name}`);
    const bytes = Buffer.from(await file.arrayBuffer());
    // The caller re-checks this after download, so a truncated transfer is
    // caught before anything downstream trusts the archive.
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/x-7z-compressed",
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="${name}"`,
        "X-Backup-Name": name,
        "X-Backup-Sha256": sha256,
        "Cache-Control": "no-store",
      },
    });
  }

  /**
   * The production checks, evaluated against the live database.
   *
   * `/health` describes the deployment; this one judges it. Every scraper's
   * newest write, the size of the last closed day against the week before it,
   * holes in the usage series, the age of the backup — `src/monitor.ts` owns
   * what each of those means, this only collects the facts.
   *
   * A failing verdict answers 503, so an uptime pinger that understands nothing
   * about the payload is still a working alarm. `/health` deliberately stays
   * 200 through all of it: Docker restarts the container on an unhealthy
   * check, and restarting the API fixes none of these.
   */
  async function handleStatus(): Promise<Response> {
    const [dbFacts, backup] = await Promise.all([storage.getMonitorFacts(), readBackupFact()]);
    const facts: MonitorFacts = { ...dbFacts, backup };
    const checks = evaluateChecks(facts);
    const status = overallStatus(checks);
    return json(
      { ok: status !== "fail", status, checkedAt: facts.nowUtc, build, checks, facts },
      status === "fail" ? 503 : 200,
    );
  }

  /**
   * The newest archive, by mtime rather than by the date in its name: the
   * question is when the cron last wrote one, not what it decided to call it.
   * A directory that is not mounted at all reads as null, so a dev instance
   * skips the backup checks instead of failing them.
   */
  async function readBackupFact(): Promise<BackupFact | null> {
    const names = await readdir(BACKUP_DIR).catch(() => null);
    if (!names) return null;
    const name = pickLatestBackup(names);
    if (!name) return { name: null, ageHours: null, bytes: null };
    const info = await stat(`${BACKUP_DIR}/${name}`).catch(() => null);
    if (!info) return { name: null, ageHours: null, bytes: null };
    return { name, ageHours: (Date.now() - info.mtimeMs) / 3_600_000, bytes: info.size };
  }

  async function handleHealth(): Promise<Response> {
    const [lastRun, coverage, counts, dbStats] = await Promise.all([
      storage.getLastIngestRun(),
      storage.getCoverage(),
      storage.countModels(),
      storage.getDatabaseStats().catch(() => null),
    ]);
    const lastRunAgeSeconds = lastRun?.startedAt
      ? Math.round((Date.now() - new Date(lastRun.startedAt).getTime()) / 1000)
      : null;
    return json({
      ok: true,
      serverTimeUtc: new Date().toISOString(),
      build,
      models: counts,
      coverage,
      ingest: lastRun ? { ...lastRun, ageSeconds: lastRunAgeSeconds } : null,
      database: dbStats,
    });
  }

  async function handleMarket(q: URLSearchParams): Promise<Response> {
    const since = sinceFromParams(q, 120);
    const excludeFree = excludeFreeFromParams(q);
    // Include delisted models: the 1-year weekly race references permaslugs that
    // have since left the catalog, and their last known price still prices them.
    const [latest, series, priceIndex, topModels, apps, appsSpend, weekly, allModels, race] = await Promise.all([
      storage.getLatestMarketSnapshot(),
      storage.getMarketUsageSeries({ since, excludeFree }),
      storage.getDailyPriceIndex({ since }),
      storage.getTopModelsByUsage(15, { excludeFree }),
      readKvJson("apps_ranking"),
      readKvJson("apps_spend"),
      readKvJson("weekly_chart"),
      storage.getModelsWithLatest({ limit: 5000 }),
      storage.getModelRace({ since: raceSince(), bucket: "week", excludeFree }),
    ]);
    return json({
      latest,
      series,
      priceIndex,
      topModels,
      apps: apps ?? { day: [], week: [], month: [] },
      appsSpend: appsSpend ?? null,
      weekly: weekly ?? { points: [] },
      race: { points: race },
      ratesByPermaslug: buildRateByPermaslug(allModels),
    });
  }

  /**
   * The model race at either grain. `/market` already ships the weekly points,
   * so this exists for the daily ones: same window at day resolution is ~7x the
   * rows, which is a lot of payload to put on every first page load for a view
   * most visitors never open. The UI fetches it when the grain is switched.
   */
  async function handleRace(q: URLSearchParams): Promise<Response> {
    const daysRaw = q.get("days");
    const days = daysRaw && /^\d+$/.test(daysRaw) ? Math.min(Number(daysRaw), 800) : RACE_DAYS;
    const bucket = q.get("bucket") === "day" ? "day" : "week";
    // The stacked bar view names a dozen models and folds the rest of the top
    // 50 into one segment, so it asks for a wider field than the default 14.
    const topRaw = q.get("top");
    const topN = topRaw && /^\d+$/.test(topRaw) ? Number(topRaw) : undefined;
    // Comma-separated model ids forced into the field regardless of rank — a
    // fresh launch's window total lags its run rate for weeks. Capped small:
    // this is a pin, not a second ranking.
    const pin = (q.get("pin") ?? "")
      .split(",")
      .map((m) => m.trim())
      .filter((m) => /^[\w.:-]+\/[\w.:-]+$/.test(m))
      .slice(0, 12);
    const points = await storage.getModelRace({
      since: raceSince(days),
      bucket,
      ...(topN !== undefined ? { topN } : {}),
      ...(pin.length ? { pin } : {}),
      excludeFree: excludeFreeFromParams(q),
    });
    return json({ bucket, points });
  }

  async function handleModels(q: URLSearchParams): Promise<Response> {
    const filter: { activeOnly?: boolean; author?: string; search?: string; provider?: string; limit?: number } = {
      activeOnly: q.get("all") !== "true",
      limit: limitFromParams(q, 1000, 5000),
    };
    const author = q.get("author");
    const search = q.get("search");
    const provider = q.get("provider");
    if (author) filter.author = author;
    if (search) filter.search = search;
    if (provider) filter.provider = provider;
    const models = await storage.getModelsWithLatest(filter);
    return json({ count: models.length, models });
  }

  async function handleFeatured(q: URLSearchParams): Promise<Response> {
    const limit = limitFromParams(q, 16, 40);
    const models = await storage.getModelsWithLatest({ activeOnly: true, limit: 5000 });
    const byUsage = [...models].sort((a, b) => (b.latestTokens ?? 0) - (a.latestTokens ?? 0));
    const picked: typeof models = [];
    const seen = new Set<string>();
    const add = (m: (typeof models)[number]) => {
      if (!seen.has(m.modelId)) {
        seen.add(m.modelId);
        picked.push(m);
      }
    };
    // Guarantee the curated frontier families, then fill by usage.
    for (const m of byUsage) if (isFrontier(m.modelId) && (m.latestTokens ?? 0) > 0) add(m);
    for (const m of byUsage) if (picked.length < limit) add(m);
    return json({ models: picked.slice(0, limit) });
  }

  async function handleModel(q: URLSearchParams): Promise<Response> {
    const id = q.get("id");
    if (!id) return json({ error: "id is required" }, 400);
    const [model] = await storage.getModelsWithLatest({ modelId: id, limit: 1 });
    if (!model) return json({ error: `Unknown model: ${id}` }, 404);
    const since = sinceFromParams(q, 180);
    const [priceHistory, providerPrices, usage] = await Promise.all([
      storage.getPriceHistory(id, { provider: "", since }),
      storage.getLatestProviderPrices(id),
      storage.getUsageHistory(id, { since }),
    ]);
    return json({ model, priceHistory, providerPrices, usage });
  }

  async function handleProviderPrices(q: URLSearchParams): Promise<Response> {
    const id = q.get("id");
    if (!id) return json({ error: "id is required" }, 400);
    const since = sinceFromParams(q, 365);
    const points = await storage.getProviderPriceHistory(id, { since });
    const providers = [...new Set(points.map((p) => p.provider))].sort((a, b) => a.localeCompare(b));
    return json({ model: id, providers, points });
  }

  /**
   * Live per-provider traffic for one model, proxied from OpenRouter's
   * `stats/endpoint` feed (request counts over a trailing ~30-minute window —
   * the only public per-provider volume signal). Cached briefly so the
   * explorer doesn't hammer OpenRouter.
   */
  async function handleProviderVolume(q: URLSearchParams): Promise<Response> {
    const id = q.get("id");
    if (!id) return json({ error: "id is required" }, 400);
    const cached = volumeCache.get(id);
    if (cached && Date.now() - cached.at < VOLUME_CACHE_MS) return json(cached.body);

    const [model] = await storage.getModelsWithLatest({ modelId: id, limit: 1 });
    if (!model) return json({ error: `Unknown model: ${id}` }, 404);
    const permaslug = model.permaslug ?? model.canonicalSlug ?? model.modelId;
    const variant = model.variant ?? "standard";
    const url = `${OPENROUTER_BASE}/api/frontend/v1/stats/endpoint?permaslug=${encodeURIComponent(permaslug)}&variant=${encodeURIComponent(variant)}`;

    let raw: unknown;
    try {
      raw = await fetchJson(url, { retries: 1, timeoutMs: 15_000, allowBrowserFallback: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ model: id, windowMinutes: null, providers: [], error: message });
    }

    const rows = parseEndpointStats(raw);
    const body = {
      model: id,
      windowMinutes: rows.find((r) => r.windowMinutes !== null)?.windowMinutes ?? null,
      providers: rows.map(({ windowMinutes: _w, ...r }) => r),
    };
    volumeCache.set(id, { at: Date.now(), body });
    return json(body);
  }

  /** Accumulated per-provider volume snapshots (captured hourly by the ingest). */
  async function handleProviderVolumeHistory(q: URLSearchParams): Promise<Response> {
    const id = q.get("id");
    if (!id) return json({ error: "id is required" }, 400);
    const rows = await storage.getProviderVolumeHistory(id, { since: sinceFromParams(q, 30) });
    return json({ model: id, points: rows });
  }

  async function handlePrices(q: URLSearchParams): Promise<Response> {
    const model = q.get("model");
    if (!model) return json({ error: "model is required" }, 400);
    const filter: { provider?: string; since?: string; limit?: number } = { since: sinceFromParams(q, 180) };
    const provider = q.get("provider");
    if (provider !== null) filter.provider = provider;
    const history = await storage.getPriceHistory(model, filter);
    return json({ model, history });
  }

  async function handleUsage(q: URLSearchParams): Promise<Response> {
    const model = q.get("model");
    if (!model) return json({ error: "model is required" }, 400);
    const filter: { since?: string; provider?: string } = { since: sinceFromParams(q, 180) };
    // provider=slug serves that provider's daily tokens; default '' = model-level.
    const provider = q.get("provider");
    if (provider !== null) filter.provider = provider;
    const usage = await storage.getUsageHistory(model, filter);
    return json({ model, usage });
  }

  /** Usage-weighted effective price history (daily sweep; '' = across providers). */
  async function handleEffectivePrices(q: URLSearchParams): Promise<Response> {
    const id = q.get("id");
    if (!id) return json({ error: "id is required" }, 400);
    const rows = await storage.getEffectivePriceHistory(id, { since: sinceFromParams(q, 90) });
    return json({ model: id, points: rows });
  }

  async function readKvJson(key: string): Promise<unknown> {
    const raw = await storage.getState(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function handleKvJson(key: string, fallback: unknown): Promise<Response> {
    return json((await readKvJson(key)) ?? fallback);
  }

  /**
   * Latest price band per accelerator, joined to the curated catalog so the
   * frontend gets labels/tier/VRAM without duplicating the list. Accelerators we
   * track but have never captured are returned with a null band rather than
   * omitted, so the UI can show them as "no data yet" instead of silently
   * shrinking the list.
   */
  async function handleGpuLatest(): Promise<Response> {
    const rows = await storage.getGpuLatest();
    const byName = new Map(rows.map((row) => [row.gpuName, row]));
    const accelerators = ACCELERATORS.map((accelerator) => ({
      ...accelerator,
      latest: byName.get(accelerator.name) ?? null,
    }));
    return json({ accelerators });
  }

  async function handleGpuSeries(params: URLSearchParams): Promise<Response> {
    const gpuName = params.get("gpu")?.trim();
    const since = sinceFromParams(params, 30);
    const series = await storage.getGpuSeries({
      ...(gpuName ? { gpuName } : {}),
      since,
      limit: limitFromParams(params, 20_000, 100_000),
    });
    return json({ series, accelerators: ACCELERATORS });
  }

  async function handleGpuDaily(params: URLSearchParams): Promise<Response> {
    const gpuName = params.get("gpu")?.trim();
    const since = sinceFromParams(params, 60);
    const daily = await storage.getGpuDaily({
      ...(gpuName ? { gpuName } : {}),
      since,
      limit: limitFromParams(params, 5_000, 20_000),
    });
    return json({ daily, accelerators: ACCELERATORS });
  }

  const server = Bun.serve({
    port: options.port,
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    async fetch(req) {
      try {
        return await handle(req);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: `Internal error: ${message}` }, 500);
      }
    },
  });

  return server;
}
