import { test, expect, describe, afterAll } from "bun:test";
import { createIsolatedStorage, hasPostgresForTests, closeTestPools } from "./testPostgres";
import { normalizePricing } from "./pricing";
import { evaluateChecks } from "./monitor";
import { priceStateKey, type ModelUpsert } from "./storage";

// Integration tests need a database. They self-skip unless TEST_DATABASE_URL
// (or DATABASE_URL) is set, so plain `bun test` stays hermetic.
const it = hasPostgresForTests() ? test : test.skip;

afterAll(async () => {
  await closeTestPools();
});

function sampleModel(id: string, canonical: string, overrides: Partial<ModelUpsert> = {}): ModelUpsert {
  return {
    modelId: id,
    canonicalSlug: canonical,
    permaslug: canonical,
    promotionText: null,
    name: id,
    author: id.split("/")[0]!,
    variant: id.includes(":") ? id.split(":")[1]! : null,
    description: null,
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
    endpointsPath: `/api/v1/models/${id}/endpoints`,
    raw: {},
    ...overrides,
  };
}

describe("Storage (integration)", () => {
  it("upserts models and marks missing ones inactive", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      await storage.upsertModel(sampleModel("z-ai/glm-5.2", "z-ai/glm-5.2-x"));
      await storage.upsertModel(sampleModel("openai/gpt-5.6-luna", "openai/gpt-5.6-luna-x"));
      let counts = await storage.countModels();
      expect(counts.total).toBe(2);
      expect(counts.active).toBe(2);

      const deactivated = await storage.deactivateMissingModels(["z-ai/glm-5.2"]);
      expect(deactivated).toBe(1);
      counts = await storage.countModels();
      expect(counts.active).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("records price changes as a change-log and returns latest state", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      await storage.upsertModel(sampleModel("z-ai/glm-5.2", "z-ai/glm-5.2-x"));
      const p1 = normalizePricing({ prompt: "0.000001", completion: "0.000002" });
      const p2 = normalizePricing({ prompt: "0.0000008", completion: "0.000002" });
      await storage.insertPricePoints([
        { modelId: "z-ai/glm-5.2", provider: "", pricing: p1, contextLength: 200000, quantization: null, isFree: false },
      ]);
      await storage.insertPricePoints([
        { modelId: "z-ai/glm-5.2", provider: "", pricing: p2, contextLength: 200000, quantization: null, isFree: false },
        { modelId: "z-ai/glm-5.2", provider: "DeepInfra", pricing: p1, contextLength: 131072, quantization: "fp8", isFree: false },
      ]);

      const latest = await storage.getLatestPrices();
      expect(latest.get("z-ai/glm-5.2\u0000")?.pricing.promptUsd).toBe(0.0000008);
      expect(latest.get("z-ai/glm-5.2\u0000DeepInfra")?.pricing.promptUsd).toBe(0.000001);

      const history = await storage.getPriceHistory("z-ai/glm-5.2", { provider: "" });
      expect(history).toHaveLength(2);
      expect(history[0]!.promptUsd).toBe(0.000001); // ascending by observed_at
      expect(history[1]!.promptUsd).toBe(0.0000008);

      const providers = await storage.getLatestProviderPrices("z-ai/glm-5.2");
      expect(providers).toHaveLength(1);
      expect(providers[0]!.provider).toBe("DeepInfra");
      expect(providers[0]!.quantization).toBe("fp8");
    } finally {
      await cleanup();
    }
  });

  // The phantom-change bug: one provider serving a model from several endpoints
  // at different prices (openai / openai/flex / openai/priority). Keyed by
  // provider name the tiers overwrote each other's last-known price and every
  // sweep logged three changes that never happened.
  it("keeps one change-log slot per endpoint, not per provider", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      await storage.upsertModel(sampleModel("openai/gpt-5.6-sol", "openai/gpt-5.6-sol-x"));
      const std = normalizePricing({ prompt: "0.0000025", completion: "0.000015" });
      const flex = normalizePricing({ prompt: "0.00000125", completion: "0.0000075" });
      const prio = normalizePricing({ prompt: "0.000005", completion: "0.00003" });
      const tiers = [
        { tag: "openai", pricing: std },
        { tag: "openai/flex", pricing: flex },
        { tag: "openai/priority", pricing: prio },
      ];
      await storage.insertPricePoints(
        tiers.map((t) => ({
          modelId: "openai/gpt-5.6-sol",
          provider: "OpenAI",
          endpointTag: t.tag,
          pricing: t.pricing,
          contextLength: 1050000,
          quantization: null,
          isFree: false,
        })),
      );

      // Each tier holds its own price, so a second identical sweep finds
      // nothing changed and writes nothing.
      const latest = await storage.getLatestPrices();
      expect(latest.get(priceStateKey("openai/gpt-5.6-sol", "openai"))?.pricing.promptUsd).toBe(0.0000025);
      expect(latest.get(priceStateKey("openai/gpt-5.6-sol", "openai/flex"))?.pricing.promptUsd).toBe(0.00000125);
      expect(latest.get(priceStateKey("openai/gpt-5.6-sol", "openai/priority"))?.pricing.promptUsd).toBe(0.000005);

      const history = await storage.getProviderPriceHistory("openai/gpt-5.6-sol");
      expect(history).toHaveLength(3);
      expect(history.map((r) => r.endpointTag).sort()).toEqual(["openai", "openai/flex", "openai/priority"]);

      // The model page lists one row per provider, quoted at its base endpoint.
      const providers = await storage.getLatestProviderPrices("openai/gpt-5.6-sol");
      expect(providers).toHaveLength(1);
      expect(providers[0]!.endpointTag).toBe("openai");
      expect(providers[0]!.promptUsd).toBe(0.0000025);

      // …and the provider rollup counts the model once, not once per tier.
      const stats = await storage.getProviderStats();
      const openai = stats.find((s) => s.provider === "OpenAI");
      expect(openai?.modelCount).toBe(1);
    } finally {
      await cleanup();
    }
  });

  // Spend used to be tokens × the newest rate, restamped across all history on
  // every sweep, so a repricing could never show as spend and tokens parting
  // company — the 50% cut to gpt-5.6-sol on 2026-08-17 retroactively marked
  // down the five days before it.
  it("prices each day at the rate in force that day, carrying back only before the first snapshot", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      await storage.upsertModel(sampleModel("openai/gpt-5.6-sol", "openai/gpt-5.6-sol-x"));
      const days = ["2026-08-11", "2026-08-13", "2026-08-18"];
      await storage.upsertUsageBatch(
        days.map((bucketDate) => ({
          modelId: "openai/gpt-5.6-sol",
          provider: "",
          bucketDate,
          tokens: 1_000_000,
          promptTokens: 900_000,
          completionTokens: 100_000,
          requests: null,
          estimatedSpendUsd: 0,
          source: "rankings",
        })),
      );
      // Full price on the 12th, half price from the 17th.
      await storage.insertEffectivePriceSnapshots(
        "openai/gpt-5.6-sol",
        [{ provider: "", effInputPerMtok: 5, effOutputPerMtok: 30, totalTokens: null }],
        new Date("2026-08-12T12:00:00Z"),
      );
      await storage.insertEffectivePriceSnapshots(
        "openai/gpt-5.6-sol",
        [{ provider: "", effInputPerMtok: 2.5, effOutputPerMtok: 15, totalTokens: null }],
        new Date("2026-08-17T17:29:00Z"),
      );

      expect(await storage.repriceUsageSpendAsOf("openai/gpt-5.6-sol")).toBe(3);
      const rows = await storage.getUsageHistory("openai/gpt-5.6-sol", { provider: "" });
      const spendOn = (date: string) => rows.find((r) => r.bucketDate === date)?.estimatedSpendUsd;

      // 0.9M × $5/M + 0.1M × $30/M = $7.50 at full price, $3.75 at half.
      expect(spendOn("2026-08-13")).toBeCloseTo(7.5, 9);
      expect(spendOn("2026-08-18")).toBeCloseTo(3.75, 9);
      // The 11th predates every snapshot: the earliest known rate carries back,
      // it does not inherit today's discount.
      expect(spendOn("2026-08-11")).toBeCloseTo(7.5, 9);
    } finally {
      await cleanup();
    }
  });

  it("upserts usage; gap-fill mode never overwrites existing rows", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      await storage.upsertModel(sampleModel("z-ai/glm-5.2", "z-ai/glm-5.2-x"));
      // Authoritative rankings row for a day.
      await storage.upsertUsageBatch(
        [
          { modelId: "z-ai/glm-5.2", provider: "", bucketDate: "2026-08-11", tokens: 100, promptTokens: 80, completionTokens: 20, requests: 5, estimatedSpendUsd: 1.5, source: "rankings" },
        ],
        { onConflict: "update" },
      );
      // Backfill (gap-fill) tries the same day + a new day.
      await storage.upsertUsageBatch(
        [
          { modelId: "z-ai/glm-5.2", provider: "", bucketDate: "2026-08-11", tokens: 999, promptTokens: null, completionTokens: null, requests: null, estimatedSpendUsd: 9, source: "backfill" },
          { modelId: "z-ai/glm-5.2", provider: "", bucketDate: "2026-08-01", tokens: 50, promptTokens: null, completionTokens: null, requests: null, estimatedSpendUsd: 0.5, source: "backfill" },
        ],
        { onConflict: "ignore" },
      );

      const usage = await storage.getUsageHistory("z-ai/glm-5.2", {});
      const byDate = new Map(usage.map((u) => [u.bucketDate, u]));
      expect(byDate.get("2026-08-11")!.tokens).toBe(100); // not clobbered by backfill
      expect(byDate.get("2026-08-01")!.tokens).toBe(50); // gap filled

      const series = await storage.getMarketUsageSeries({});
      const total = series.find((s) => s.bucketDate === "2026-08-11");
      expect(total?.totalTokens).toBe(100);
    } finally {
      await cleanup();
    }
  });

  it("races models weekly and daily off the same snapshots", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      await storage.upsertModel(sampleModel("z-ai/glm-5.2", "z-ai/glm-5.2-x"));
      await storage.upsertModel(sampleModel("openai/gpt-5.6-luna", "openai/gpt-5.6-luna-x"));
      // Aug 3 and Aug 10 are Mondays; the week of Aug 17 gets two days only, so
      // it is partial and must not reach the weekly grain.
      const days: string[] = [];
      for (let d = 3; d <= 18; d++) days.push(`2026-08-${String(d).padStart(2, "0")}`);
      await storage.upsertUsageBatch(
        days.flatMap((bucketDate) => [
          // Volume model: cheap tokens, lots of them.
          { modelId: "z-ai/glm-5.2", provider: "", bucketDate, tokens: 1000, promptTokens: null, completionTokens: null, requests: null, estimatedSpendUsd: 1, source: "rankings" },
          // Premium model: a tenth of the tokens at ten times the money — it
          // only survives the cut because the field is ranked by both.
          { modelId: "openai/gpt-5.6-luna", provider: "", bucketDate, tokens: 100, promptTokens: null, completionTokens: null, requests: null, estimatedSpendUsd: 10, source: "rankings" },
        ]),
        { onConflict: "update" },
      );

      const weekly = await storage.getModelRace({ since: "2026-08-01", bucket: "week" });
      expect(weekly.map((p) => p.date)).toEqual(["2026-08-03", "2026-08-10"]); // Aug 17 is partial
      expect(weekly[0]!.tokensByModel["z-ai/glm-5.2"]).toBe(7000);
      expect(weekly[0]!.spendByModel["openai/gpt-5.6-luna"]).toBe(70);

      const daily = await storage.getModelRace({ since: "2026-08-01", bucket: "day" });
      expect(daily).toHaveLength(days.length); // every day, partial week included
      expect(daily[0]!.date).toBe("2026-08-03");
      expect(daily[daily.length - 1]!.date).toBe("2026-08-18");
      expect(daily[0]!.tokensByModel["z-ai/glm-5.2"]).toBe(1000);
      expect(daily[0]!.spendByModel["openai/gpt-5.6-luna"]).toBe(10);

      // Same money either way: the daily points sum back to the week's.
      const firstWeek = daily.filter((p) => p.date <= "2026-08-09");
      const summed = firstWeek.reduce((acc, p) => acc + (p.spendByModel["z-ai/glm-5.2"] ?? 0), 0);
      expect(summed).toBe(weekly[0]!.spendByModel["z-ai/glm-5.2"]!);

      // topN cuts the field, and it is a union of both rankings — the premium
      // model wins on spend, the volume model on tokens, so 1 keeps both.
      const cut = await storage.getModelRace({ since: "2026-08-01", bucket: "day", topN: 1 });
      expect(Object.keys(cut[0]!.spendByModel).sort()).toEqual(["openai/gpt-5.6-luna", "z-ai/glm-5.2"]);
    } finally {
      await cleanup();
    }
  });

  it("refresh-own restates the same source's rows and spares everyone else's", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      await storage.upsertModel(sampleModel("z-ai/glm-5.2", "z-ai/glm-5.2-x"));
      const row = (bucketDate: string, tokens: number, source: string) => ({
        modelId: "z-ai/glm-5.2", provider: "", bucketDate, tokens,
        promptTokens: null, completionTokens: null, requests: null, estimatedSpendUsd: tokens / 100, source,
      });
      await storage.upsertUsageBatch([row("2026-08-11", 100, "rankings")], { onConflict: "update" });
      // The double-counted history this mode exists to correct.
      await storage.upsertUsageBatch([row("2026-08-01", 999, "provider-token-chart")], { onConflict: "ignore" });

      const written = await storage.upsertUsageBatch(
        [
          row("2026-08-11", 555, "provider-token-chart"), // rankings owns this day
          row("2026-08-01", 500, "provider-token-chart"), // its own — restated
          row("2026-07-31", 42, "provider-token-chart"), // brand new — inserted
        ],
        { onConflict: "refresh-own" },
      );

      const byDate = new Map((await storage.getUsageHistory("z-ai/glm-5.2", {})).map((u) => [u.bucketDate, u]));
      expect(byDate.get("2026-08-11")!.tokens).toBe(100); // rankings row untouched
      expect(byDate.get("2026-08-01")!.tokens).toBe(500); // own row corrected
      expect(byDate.get("2026-08-01")!.estimatedSpendUsd).toBe(5);
      expect(byDate.get("2026-07-31")!.tokens).toBe(42);
      expect(written).toBe(2); // the guarded row reports no write
    } finally {
      await cleanup();
    }
  });

  it("lists the model ids a source wrote, so a refresh can find its own rows", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      await storage.upsertModel(sampleModel("z-ai/glm-5.2", "z-ai/glm-5.2-x"));
      await storage.upsertModel(sampleModel("openai/gpt-5.5", "openai/gpt-5.5-x"));
      const row = (modelId: string, provider: string, source: string) => ({
        modelId, provider, bucketDate: "2026-08-01", tokens: 10,
        promptTokens: null, completionTokens: null, requests: null, estimatedSpendUsd: 1, source,
      });
      await storage.upsertUsageBatch([
        row("z-ai/glm-5.2", "", "provider-token-chart"),
        row("openai/gpt-5.5", "", "rankings"),
        row("openai/gpt-5.5", "novita", "provider-token-chart"), // provider-keyed, not model-level
      ]);

      expect(await storage.getModelIdsBySource("provider-token-chart")).toEqual(["z-ai/glm-5.2"]);
      expect(await storage.getModelIdsBySource("rankings")).toEqual(["openai/gpt-5.5"]);
    } finally {
      await cleanup();
    }
  });

  it("joins latest price + usage into getModelsWithLatest", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      await storage.upsertModel(sampleModel("z-ai/glm-5.2", "z-ai/glm-5.2-x"));
      await storage.insertPricePoints([
        { modelId: "z-ai/glm-5.2", provider: "", pricing: normalizePricing({ prompt: "0.00000049", completion: "0.00000154" }), contextLength: 200000, quantization: null, isFree: false },
      ]);
      await storage.upsertUsage({ modelId: "z-ai/glm-5.2", provider: "", bucketDate: "2026-08-11", tokens: 1234, promptTokens: null, completionTokens: null, requests: null, estimatedSpendUsd: 2.5, source: "rankings" });

      const [m] = await storage.getModelsWithLatest({ modelId: "z-ai/glm-5.2" });
      expect(m).toBeDefined();
      expect(m!.promptUsd).toBe(0.00000049);
      expect(m!.completionUsd).toBe(0.00000154);
      expect(m!.latestTokens).toBe(1234);
      expect(m!.latestUsageDate).toBe("2026-08-11");
    } finally {
      await cleanup();
    }
  });

  it("stores and reads market snapshots + coverage", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      await storage.upsertModel(sampleModel("z-ai/glm-5.2", "z-ai/glm-5.2-x"));
      await storage.upsertUsage({ modelId: "z-ai/glm-5.2", provider: "", bucketDate: "2026-08-11", tokens: 1000, promptTokens: null, completionTokens: null, requests: null, estimatedSpendUsd: 3, source: "rankings" });
      await storage.insertMarketSnapshot({
        capturedAt: new Date("2026-08-12T00:00:00Z"),
        totalModels: 1,
        activeModels: 1,
        freeModels: 0,
        totalDailyTokens: 1000,
        totalEstimatedDailySpendUsd: 3,
        avgPromptUsdPerMtok: 0.5,
        medianPromptUsdPerMtok: 0.5,
        usageWeightedPromptUsdPerMtok: 0.5,
        cheapestFrontierUsdPerMtok: 0.5,
      });

      const latest = await storage.getLatestMarketSnapshot();
      expect(latest?.totalDailyTokens).toBe(1000);
      expect(latest?.usageWeightedPromptUsdPerMtok).toBe(0.5);

      const coverage = await storage.getCoverage();
      expect(coverage.usageDateMin).toBe("2026-08-11");
      expect(coverage.usageDays).toBe(1);
      expect(coverage.marketSnapshots).toBe(1);
    } finally {
      await cleanup();
    }
  });

  // The facts behind /status. Worth a real database rather than a fixture:
  // the hole detection is a generate_series the pure checks can only trust,
  // and a source that has never written anything must read as null instead of
  // making the whole query throw.
  it("collects monitor facts, including days the scraper missed", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      await storage.upsertModel(sampleModel("z-ai/glm-5.2", "z-ai/glm-5.2-x"));
      const usage = (bucketDate: string, provider: string, tokens: number) => ({
        modelId: "z-ai/glm-5.2",
        provider,
        bucketDate,
        tokens,
        promptTokens: null,
        completionTokens: null,
        requests: null,
        estimatedSpendUsd: tokens / 1000,
        source: provider ? "provider-token-chart" : "rankings",
      });
      // 08-12 is missing at model level: the shape of a day nobody scraped.
      await storage.upsertUsage(usage("2026-08-11", "", 1000));
      await storage.upsertUsage(usage("2026-08-13", "", 1200));
      // A per-provider row on the missing day must not paper over the hole.
      await storage.upsertUsage(usage("2026-08-12", "deepinfra", 900));
      await storage.insertMarketSnapshot({
        capturedAt: new Date(),
        totalModels: 1,
        activeModels: 1,
        freeModels: 0,
        totalDailyTokens: 1000,
        totalEstimatedDailySpendUsd: 3,
        avgPromptUsdPerMtok: 0.5,
        medianPromptUsdPerMtok: 0.5,
        usageWeightedPromptUsdPerMtok: 0.5,
        cheapestFrontierUsdPerMtok: 0.5,
      });

      const facts = await storage.getMonitorFacts();
      expect(facts.nowUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(facts.usage.firstDate).toBe("2026-08-11");
      expect(facts.usage.lastDate).toBe("2026-08-13");
      expect(facts.usage.missingDates).toEqual(["2026-08-12"]);
      expect(facts.usage.daily.map((d) => d.date)).toEqual(["2026-08-11", "2026-08-13"]);
      expect(facts.usage.daily[0]!.tokens).toBe(1000);
      expect(facts.latest.usageModel).not.toBeNull();
      expect(facts.latest.usageProvider).not.toBeNull();
      expect(facts.catalog).toMatchObject({ total: 1, active: 1, activeMedian7d: 1 });
      // Sources this instance has never written read as absent, not as an error.
      expect(facts.latest.gpuSweep).toBeNull();
      expect(facts.gpu).toEqual({ accelerators: 0, withOffers: 0 });
      expect(facts.ingest.lastOk).toBeNull();

      const gaps = evaluateChecks({ ...facts, backup: null }).find((c) => c.name === "usage.gaps");
      expect(gaps?.status).toBe("fail");
      expect(gaps?.detail).toContain("2026-08-12");
    } finally {
      await cleanup();
    }
  });
});
