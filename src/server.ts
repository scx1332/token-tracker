import { Storage } from "./storage";
import { readBuildInfo } from "./buildInfo";
import { isFrontier } from "./frontier";

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

function limitFromParams(params: URLSearchParams, def: number, max: number): number {
  const raw = params.get("limit");
  if (raw && /^\d+$/.test(raw)) return Math.min(Number(raw), max);
  return def;
}

export function createServer(storage: Storage, options: ServerOptions) {
  const build = readBuildInfo();

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
      case "/market":
        return handleMarket(q);
      case "/market/series":
        return json({ series: await storage.getMarketUsageSeries({ since: sinceFromParams(q, 120) }) });
      case "/market/snapshots":
        return json({ snapshots: await storage.getMarketSnapshots({ since: sinceFromParams(q, 120) }) });
      case "/models":
        return handleModels(q);
      case "/models/featured":
        return handleFeatured(q);
      case "/model":
        return handleModel(q);
      case "/prices":
        return handlePrices(q);
      case "/usage":
        return handleUsage(q);
      case "/providers":
        return json({ providers: await storage.getProviderStats() });
      case "/apps":
        return handleKvJson("apps_ranking", { day: [], week: [], month: [] });
      case "/usage/weekly":
        return handleKvJson("weekly_chart", { points: [] });
      default:
        return json({ error: `Not found: ${path}` }, 404);
    }
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
    const [latest, series, snapshots, topModels, apps, weekly] = await Promise.all([
      storage.getLatestMarketSnapshot(),
      storage.getMarketUsageSeries({ since }),
      storage.getMarketSnapshots({ since }),
      storage.getTopModelsByUsage(15),
      readKvJson("apps_ranking"),
      readKvJson("weekly_chart"),
    ]);
    return json({
      latest,
      series,
      snapshots,
      topModels,
      apps: apps ?? { day: [], week: [], month: [] },
      weekly: weekly ?? { points: [] },
    });
  }

  async function handleModels(q: URLSearchParams): Promise<Response> {
    const filter: { activeOnly?: boolean; author?: string; search?: string; limit?: number } = {
      activeOnly: q.get("all") !== "true",
      limit: limitFromParams(q, 1000, 5000),
    };
    const author = q.get("author");
    const search = q.get("search");
    if (author) filter.author = author;
    if (search) filter.search = search;
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
    const usage = await storage.getUsageHistory(model, { since: sinceFromParams(q, 180) });
    return json({ model, usage });
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
