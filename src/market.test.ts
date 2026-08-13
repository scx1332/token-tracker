import { test, expect, describe } from "bun:test";
import { computeMarketAggregates, blendedPerMtok, buildRateByPermaslug, aggregateAppSpend } from "./market";
import type { ModelWithLatest } from "./storage";

function model(partial: Partial<ModelWithLatest>): ModelWithLatest {
  return {
    modelId: partial.modelId ?? "a/b",
    canonicalSlug: partial.canonicalSlug ?? null,
    permaslug: partial.permaslug ?? null,
    promotionText: null,
    name: partial.modelId ?? "a/b",
    author: "a",
    variant: partial.variant ?? null,
    description: null,
    contextLength: null,
    modality: null,
    inputModalities: null,
    outputModalities: null,
    tokenizer: null,
    huggingFaceId: null,
    supportedParameters: null,
    isModerated: null,
    createdOr: null,
    knowledgeCutoff: null,
    firstSeenAt: "",
    lastSeenAt: "",
    isActive: partial.isActive ?? true,
    promptUsd: partial.promptUsd ?? null,
    completionUsd: partial.completionUsd ?? null,
    requestUsd: null,
    imageUsd: null,
    isFree: partial.isFree ?? false,
    priceObservedAt: null,
    latestTokens: partial.latestTokens ?? null,
    latestSpendUsd: partial.latestSpendUsd ?? null,
    latestUsageDate: null,
    providerCount: 0,
  };
}

describe("blendedPerMtok", () => {
  test("blends 90/10 and scales to per-Mtok", () => {
    expect(blendedPerMtok(0.000001, 0.000003)).toBeCloseTo(1.2, 8);
  });
  test("falls back to whichever side exists", () => {
    expect(blendedPerMtok(0.000001, null)).toBeCloseTo(1, 8);
  });
  test("null when unpriced", () => {
    expect(blendedPerMtok(null, null)).toBeNull();
  });
});

describe("computeMarketAggregates", () => {
  const models = [
    model({ modelId: "z-ai/glm-5.2", promptUsd: 0.000001, completionUsd: 0.000002, latestTokens: 1000 }),
    model({ modelId: "openai/gpt-5.6-luna", promptUsd: 0.000002, completionUsd: 0.000004, latestTokens: 3000 }),
    model({ modelId: "x/free", promptUsd: 0, completionUsd: 0, isFree: true, latestTokens: 5000 }),
    model({ modelId: "x/nousage", promptUsd: 0.000005, completionUsd: 0.00001, latestTokens: null }),
  ];
  const agg = computeMarketAggregates(models, 4);

  test("counts models and free models", () => {
    expect(agg.totalModels).toBe(4);
    expect(agg.activeModels).toBe(4);
    expect(agg.freeModels).toBe(1);
  });
  test("average prompt $/Mtok over paid models", () => {
    // paid prompt $/Mtok: 1, 2, 5 -> mean 8/3
    expect(agg.avgPromptUsdPerMtok).toBeCloseTo((1 + 2 + 5) / 3, 6);
  });
  test("median prompt $/Mtok", () => {
    expect(agg.medianPromptUsdPerMtok).toBeCloseTo(2, 6);
  });
  test("usage-weighted prompt $/Mtok weights by tokens", () => {
    // (1*1000 + 2*3000) / (1000+3000) = 7000/4000 = 1.75  (free + no-usage excluded)
    expect(agg.usageWeightedPromptUsdPerMtok).toBeCloseTo(1.75, 6);
  });
  test("cheapest frontier is the min blended among top-usage priced models", () => {
    // top by usage among priced (90/10): luna (2.2), glm (1.1) -> cheapest 1.1
    expect(agg.cheapestFrontierUsdPerMtok).toBeCloseTo(1.1, 6);
  });
});

describe("buildRateByPermaslug", () => {
  test("prefers the observed effective rate over the blended list price", () => {
    const rates = buildRateByPermaslug([
      model({
        modelId: "a/x",
        permaslug: "a/x-20260101",
        promptUsd: 0.00001, // blended would be $10/M…
        completionUsd: 0.00001,
        latestSpendUsd: 2, // …but observed: $2 over 1M tokens = $2/M effective
        latestTokens: 1_000_000,
      }),
    ]);
    expect(rates["a/x-20260101"]).toBeCloseTo(2e-6, 12);
  });

  test("falls back to the 90/10 blended list price without usage", () => {
    const rates = buildRateByPermaslug([
      model({ modelId: "a/y", permaslug: "a/y-20260101", promptUsd: 0.000001, completionUsd: 0.000003 }),
    ]);
    expect(rates["a/y-20260101"]).toBeCloseTo(1.2e-6, 12);
  });

  test("free models never price a permaslug", () => {
    const rates = buildRateByPermaslug([
      model({ modelId: "a/z", permaslug: "a/z-20260101", promptUsd: 0.000002, completionUsd: 0.000002, latestTokens: 10 }),
      model({ modelId: "a/z:free", permaslug: "a/z-20260101", variant: "free", isFree: true, latestTokens: 99999 }),
      model({ modelId: "a/onlyfree:free", permaslug: "a/onlyfree-20260101", variant: "free", isFree: true }),
    ]);
    expect(rates["a/z-20260101"]).toBeCloseTo(2e-6, 12); // busier free variant must not win
    expect(rates["a/onlyfree-20260101"]).toBeUndefined(); // free-only slug stays unpriced
  });

  test("the busiest model wins a shared permaslug", () => {
    const rates = buildRateByPermaslug([
      model({ modelId: "a/w", permaslug: "a/w-20260101", promptUsd: 0.000002, completionUsd: 0.000002, latestTokens: 100 }),
      model({ modelId: "a/w:thinking", permaslug: "a/w-20260101", variant: "thinking", promptUsd: 0.000008, completionUsd: 0.000008, latestTokens: 5 }),
    ]);
    expect(rates["a/w-20260101"]).toBeCloseTo(2e-6, 12);
  });
});

describe("aggregateAppSpend", () => {
  const app = (appId: number, title: string, tokens: number | null) => ({ appId, title, url: null, tokens });

  test("sums an app's spend across models and ranks by dollars", () => {
    const rows = aggregateAppSpend([
      // expensive model: 100M tok × $10/M
      { modelId: "a/pricey", rate: 1e-5, apps: [app(1, "Agent", 100e6), app(2, "Chat", 10e6)] },
      // cheap model: huge tokens, little money: 5B tok × $0.1/M
      { modelId: "b/cheap", rate: 1e-7, apps: [app(2, "Chat", 5e9), app(3, "RP", 4e9)] },
    ]);
    expect(rows.map((r) => r.title)).toEqual(["Agent", "Chat", "RP"]);
    expect(rows[0]!.spendUsd).toBeCloseTo(1000, 6);
    expect(rows[1]!.spendUsd).toBeCloseTo(100 + 500, 6); // both models contribute
    expect(rows[1]!.tokens).toBe(10e6 + 5e9);
  });

  test("lists top contributing models by spend, largest first", () => {
    const rows = aggregateAppSpend([
      { modelId: "a/x", rate: 1e-6, apps: [app(1, "Agent", 1e6)] }, // $1
      { modelId: "a/y", rate: 1e-6, apps: [app(1, "Agent", 9e6)] }, // $9
    ]);
    expect(rows[0]!.topModels).toEqual(["a/y", "a/x"]);
  });

  test("skips null/zero token entries and negative rates", () => {
    const rows = aggregateAppSpend([
      { modelId: "a/x", rate: 1e-6, apps: [app(1, "Agent", null), app(2, "Chat", 0)] },
      { modelId: "a/bad", rate: -1, apps: [app(3, "RP", 1e6)] },
    ]);
    expect(rows).toEqual([]);
  });

  test("merges by app id, falling back to title when id is missing", () => {
    const rows = aggregateAppSpend([
      { modelId: "a/x", rate: 1e-6, apps: [{ appId: null, title: "Mystery", url: null, tokens: 1e6 }] },
      { modelId: "a/y", rate: 1e-6, apps: [{ appId: null, title: "Mystery", url: null, tokens: 2e6 }] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spendUsd).toBeCloseTo(3, 9);
  });
});
