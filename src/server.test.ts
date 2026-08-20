import { test, expect, describe, afterAll } from "bun:test";
import { createIsolatedStorage, hasPostgresForTests, closeTestPools } from "./testPostgres";
import { createServer } from "./server";
import { normalizePricing } from "./pricing";
import type { Storage } from "./storage";

const it = hasPostgresForTests() ? test : test.skip;

afterAll(async () => {
  await closeTestPools();
});

async function seed(storage: Storage) {
  await storage.upsertModel({
    modelId: "z-ai/glm-5.2",
    canonicalSlug: "z-ai/glm-5.2-x",
    permaslug: "z-ai/glm-5.2-x",
    promotionText: null,
    name: "Z.ai: GLM 5.2",
    author: "z-ai",
    variant: null,
    description: "test model",
    contextLength: 200000,
    modality: "text->text",
    inputModalities: ["text"],
    outputModalities: ["text"],
    tokenizer: "Other",
    huggingFaceId: null,
    supportedParameters: ["tools"],
    isModerated: false,
    createdOr: new Date().toISOString(),
    knowledgeCutoff: null,
    endpointsPath: null,
    raw: {},
  });
  await storage.insertPricePoints([
    { modelId: "z-ai/glm-5.2", provider: "", pricing: normalizePricing({ prompt: "0.00000049", completion: "0.00000154" }), contextLength: 200000, quantization: null, isFree: false },
    { modelId: "z-ai/glm-5.2", provider: "DeepInfra", pricing: normalizePricing({ prompt: "0.0000006", completion: "0.0000018" }), contextLength: 131072, quantization: "fp8", isFree: false },
  ]);
  await storage.upsertUsage({ modelId: "z-ai/glm-5.2", provider: "", bucketDate: "2026-08-11", tokens: 1234, promptTokens: null, completionTokens: null, requests: 9, estimatedSpendUsd: 2.5, source: "rankings" });
  await storage.insertMarketSnapshot({
    capturedAt: new Date("2026-08-12T00:00:00Z"),
    totalModels: 1, activeModels: 1, freeModels: 0,
    totalDailyTokens: 1234, totalEstimatedDailySpendUsd: 2.5,
    avgPromptUsdPerMtok: 0.49, medianPromptUsdPerMtok: 0.49,
    usageWeightedPromptUsdPerMtok: 0.49, cheapestFrontierUsdPerMtok: 0.49,
  });
  await storage.setState("weekly_chart", JSON.stringify({ points: [{ date: "2026-08-01", tokensByPermaslug: { "z-ai/glm-5.2-x": 5 } }] }));
}

describe("HTTP server (integration)", () => {
  it("serves the full API surface", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    const server = createServer(storage, { port: 0, hostname: "127.0.0.1" });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      await seed(storage);

      const health = await (await fetch(`${base}/health`)).json();
      expect(health.ok).toBe(true);
      expect(health.models.total).toBe(1);
      expect(health.coverage.usageDays).toBe(1);

      const models = await (await fetch(`${base}/models`)).json();
      expect(models.count).toBe(1);
      expect(models.models[0].promptUsd).toBe(0.00000049);
      expect(models.models[0].latestTokens).toBe(1234);

      const detail = await (await fetch(`${base}/model?id=${encodeURIComponent("z-ai/glm-5.2")}`)).json();
      expect(detail.model.modelId).toBe("z-ai/glm-5.2");
      expect(detail.model.promptUsd).toBe(0.00000049); // price-enriched, not bare StoredModel
      expect(detail.providerPrices).toHaveLength(1);
      expect(detail.providerPrices[0].provider).toBe("DeepInfra");

      const market = await (await fetch(`${base}/market`)).json();
      expect(market.latest.totalDailyTokens).toBe(1234);
      expect(market.topModels.length).toBeGreaterThan(0);

      const providers = await (await fetch(`${base}/providers`)).json();
      expect(providers.providers[0].provider).toBe("DeepInfra");

      const weekly = await (await fetch(`${base}/usage/weekly`)).json();
      expect(weekly.points).toHaveLength(1);

      const notFound = await fetch(`${base}/model?id=nope/nope`);
      expect(notFound.status).toBe(404);

      const badPath = await fetch(`${base}/nonsense`);
      expect(badPath.status).toBe(404);
    } finally {
      server.stop(true);
      await cleanup();
    }
  });

  it("filters /models by the provider serving them, whatever the casing", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    const server = createServer(storage, { port: 0, hostname: "127.0.0.1" });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      await seed(storage);

      // The providers board links here with the display-cased name; a
      // hand-typed link carries whatever the user typed.
      for (const name of ["DeepInfra", "deepinfra"]) {
        const hit = await (await fetch(`${base}/models?provider=${name}`)).json();
        expect(hit.count).toBe(1);
        expect(hit.models[0].modelId).toBe("z-ai/glm-5.2");
      }

      // A provider that serves nothing here narrows to nothing — it must not
      // fall back to the unfiltered board.
      const miss = await (await fetch(`${base}/models?provider=Nebius`)).json();
      expect(miss.count).toBe(0);

      // An empty param is no filter at all — not a filter on the model-level
      // price row, whose provider is stored as "".
      const empty = await (await fetch(`${base}/models?provider=`)).json();
      expect(empty.count).toBe(1);
    } finally {
      server.stop(true);
      await cleanup();
    }
  });

  it("serves /status, and says 503 when the pipeline is not running", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    const server = createServer(storage, { port: 0, hostname: "127.0.0.1" });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      await seed(storage);

      // This database has a catalog and one usage row but has never run an
      // ingest pass. The checks are meant to say so, loudly.
      const res = await fetch(`${base}/status`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.status).toBe("fail");
      expect(body.checks.find((c: { name: string }) => c.name === "ingest.pass").status).toBe("fail");
      expect(body.checks.find((c: { name: string }) => c.name === "catalog.scrape").status).toBe("ok");
      // No backup directory is mounted under test, so those skip rather than fail.
      expect(body.checks.find((c: { name: string }) => c.name === "backup.age").status).toBe("skip");
      expect(body.facts.catalog.active).toBe(1);

      // ...while /health stays 200 through all of it: Docker restarts the
      // container on an unhealthy check, and a restart fixes none of this.
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      server.stop(true);
      await cleanup();
    }
  });
});
