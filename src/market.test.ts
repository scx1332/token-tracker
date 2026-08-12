import { test, expect, describe } from "bun:test";
import { computeMarketAggregates, blendedPerMtok } from "./market";
import type { ModelWithLatest } from "./storage";

function model(partial: Partial<ModelWithLatest>): ModelWithLatest {
  return {
    modelId: partial.modelId ?? "a/b",
    canonicalSlug: null,
    permaslug: null,
    promotionText: null,
    name: partial.modelId ?? "a/b",
    author: "a",
    variant: null,
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
    latestSpendUsd: null,
    latestUsageDate: null,
    providerCount: 0,
  };
}

describe("blendedPerMtok", () => {
  test("blends 50/50 and scales to per-Mtok", () => {
    expect(blendedPerMtok(0.000001, 0.000003)).toBeCloseTo(2, 8);
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
    // top by usage among priced: luna (blended 3), glm (blended 1.5) -> cheapest 1.5
    expect(agg.cheapestFrontierUsdPerMtok).toBeCloseTo(1.5, 6);
  });
});
