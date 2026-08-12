import { test, expect, describe } from "bun:test";
import { toModelUpsert, buildUsageIndex, resolveUsageModelId } from "./modelMap";
import { modelAuthor, modelVariant, endpointsSlug } from "./openrouter";
import type { OpenRouterModel } from "./types";

describe("id helpers", () => {
  test("modelAuthor extracts the org", () => {
    expect(modelAuthor("z-ai/glm-5.2")).toBe("z-ai");
    expect(modelAuthor("~deepseek/deepseek-v4-flash-latest")).toBe("deepseek");
    expect(modelAuthor("noslash")).toBe("noslash");
  });
  test("modelVariant extracts the suffix", () => {
    expect(modelVariant("openai/gpt-5.6-luna:batch")).toBe("batch");
    expect(modelVariant("z-ai/glm-5.2")).toBeNull();
  });
  test("endpointsSlug strips ~ prefix and :variant", () => {
    expect(endpointsSlug("~deepseek/deepseek-v4-flash-latest")).toBe("deepseek/deepseek-v4-flash-latest");
    expect(endpointsSlug("openai/gpt-5.6-luna:batch")).toBe("openai/gpt-5.6-luna");
  });
});

describe("toModelUpsert", () => {
  const model: OpenRouterModel & { canonical_slug: string } = {
    id: "z-ai/glm-5.2",
    canonical_slug: "z-ai/glm-5.2-20260616",
    name: "Z.ai: GLM 5.2",
    created: 1_760_000_000,
    context_length: 200000,
    architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"], tokenizer: "Other" },
    pricing: { prompt: "0.00000049", completion: "0.00000154" },
    top_provider: { is_moderated: false },
  };

  test("derives author, permaslug (= canonical_slug), created timestamp", () => {
    const u = toModelUpsert(model, { promotionText: "10% off" });
    expect(u.author).toBe("z-ai");
    expect(u.permaslug).toBe("z-ai/glm-5.2-20260616");
    expect(u.canonicalSlug).toBe("z-ai/glm-5.2-20260616");
    expect(u.variant).toBeNull();
    expect(u.promotionText).toBe("10% off");
    expect(u.modality).toBe("text->text");
    expect(u.createdOr).toBe(new Date(1_760_000_000 * 1000).toISOString());
  });
});

describe("usage index", () => {
  const catalog = [
    { id: "z-ai/glm-5.2", canonical_slug: "z-ai/glm-5.2-20260616" },
    { id: "deepseek/deepseek-chat", canonical_slug: "deepseek/deepseek-chat-v3" },
    { id: "deepseek/deepseek-chat:free", canonical_slug: "deepseek/deepseek-chat-v3" },
    { id: "~deepseek/deepseek-v4-flash-latest", canonical_slug: "deepseek/deepseek-v4-flash-20260423" },
    { id: "deepseek/deepseek-v4-flash", canonical_slug: "deepseek/deepseek-v4-flash-20260423" },
  ];
  const idx = buildUsageIndex(catalog);

  test("standard variant resolves to the base id", () => {
    expect(resolveUsageModelId(idx, "z-ai/glm-5.2-20260616", "standard")).toBe("z-ai/glm-5.2");
  });
  test("free variant resolves to the :free id", () => {
    expect(resolveUsageModelId(idx, "deepseek/deepseek-chat-v3", "free")).toBe("deepseek/deepseek-chat:free");
  });
  test("unknown variant falls back to the base model", () => {
    expect(resolveUsageModelId(idx, "deepseek/deepseek-chat-v3", "thinking")).toBe("deepseek/deepseek-chat");
  });
  test("non-alias id wins over a ~ alias for the same permaslug/variant", () => {
    expect(resolveUsageModelId(idx, "deepseek/deepseek-v4-flash-20260423", "standard")).toBe("deepseek/deepseek-v4-flash");
  });
  test("unknown permaslug resolves to null", () => {
    expect(resolveUsageModelId(idx, "nobody/nothing", "standard")).toBeNull();
  });
});
