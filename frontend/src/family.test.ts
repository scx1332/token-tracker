import { describe, expect, it } from "bun:test";
import { familyOf, familySeries, groupByFamily } from "./family";

const key = (id: string) => familyOf(id).key;

describe("familyOf", () => {
  it("folds every version of one Anthropic line together", () => {
    expect(key("anthropic/claude-opus-5")).toBe("claude-opus");
    expect(key("anthropic/claude-opus-4.8")).toBe("claude-opus");
    expect(key("anthropic/claude-opus-4.6")).toBe("claude-opus");
    expect(key("anthropic/claude-sonnet-5")).toBe("claude-sonnet");
    expect(key("anthropic/claude-sonnet-4.6")).toBe("claude-sonnet");
    expect(key("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet");
  });

  it("keeps Opus, Sonnet, Fable and Haiku apart", () => {
    const keys = ["claude-opus-5", "claude-sonnet-5", "claude-fable-5.1", "claude-haiku-4.5"].map((m) =>
      key(`anthropic/${m}`),
    );
    expect(new Set(keys).size).toBe(4);
  });

  it("joins GLM 5.2 and 5.3, and every Flash cut into its own line", () => {
    expect(key("z-ai/glm-5.2")).toBe("glm-5.2-5.3");
    expect(key("z-ai/glm-5.3")).toBe("glm-5.2-5.3");
    expect(key("z-ai/glm-5.3-flash")).toBe("glm-flash");
    expect(key("z-ai/glm-5.2-flash")).toBe("glm-flash");
    expect(key("z-ai/glm-4.7-flash")).toBe("glm-flash");
    expect(key("z-ai/glm-5-flash")).toBe("glm-flash");
    // Older generations stay their own rows.
    expect(key("z-ai/glm-5.1")).toBe("z-ai/glm-5.1");
    expect(key("z-ai/glm-4.7")).toBe("z-ai/glm-4.7");
  });

  it("joins DeepSeek's dated re-cuts, Flash and Pro separately", () => {
    expect(key("deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(key("deepseek/deepseek-v4-flash-0731")).toBe("deepseek-v4-flash");
    expect(key("deepseek/deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(key("deepseek/deepseek-v4-pro-0813")).toBe("deepseek-v4-pro");
    expect(key("deepseek/deepseek-v3.2")).toBe("deepseek/deepseek-v3.2");
  });

  it("joins the Qwen3.8 Max refresh", () => {
    expect(key("qwen/qwen3.8-max")).toBe("qwen3.8-max");
    expect(key("qwen/qwen3.8-max-new")).toBe("qwen3.8-max");
  });

  it("joins every Google Flash tier and generation", () => {
    for (const m of ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-3.1-flash-lite"]) {
      expect(key(`google/${m}`)).toBe("gemini-flash");
    }
    expect(key("google/gemini-3.1-pro-preview")).toBe("google/gemini-3.1-pro-preview");
  });

  it("leaves models sold side by side alone", () => {
    expect(key("openai/gpt-5.6-sol")).toBe("openai/gpt-5.6-sol");
    expect(key("openai/gpt-5.6-luna")).toBe("openai/gpt-5.6-luna");
    expect(familyOf("openai/gpt-5.6-sol", "OpenAI: GPT-5.6 Sol").label).toBe("OpenAI: GPT-5.6 Sol");
  });
});

describe("groupByFamily", () => {
  const rows = [
    { modelId: "anthropic/claude-opus-5", name: "Claude Opus 5", tokens: 10, spendUsd: 400 },
    { modelId: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8", tokens: 5, spendUsd: 130 },
    { modelId: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", tokens: 20, spendUsd: 325 },
    { modelId: "deepseek/deepseek-v4-flash-0731", name: "V4 Flash 0731", tokens: 3, spendUsd: 80 },
    { modelId: "deepseek/deepseek-v4-flash", name: "V4 Flash", tokens: 2, spendUsd: 40 },
  ];

  it("sums a family's spend and tokens and ranks by the total", () => {
    const grouped = groupByFamily(rows);
    expect(grouped.map((g) => g.key)).toEqual(["claude-opus", "openai/gpt-5.6-sol", "deepseek-v4-flash"]);
    expect(grouped[0]!.spendUsd).toBe(530);
    expect(grouped[0]!.tokens).toBe(15);
    expect(grouped[0]!.label).toBe("Claude Opus");
  });

  it("orders members biggest first so the row can link its head", () => {
    const grouped = groupByFamily(rows);
    expect(grouped[0]!.members.map((m) => m.modelId)).toEqual([
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-4.8",
    ]);
  });

  it("labels a lone model with its own name, not its slug", () => {
    expect(groupByFamily(rows)[1]!.label).toBe("GPT-5.6 Sol");
  });

  it("treats missing values as zero", () => {
    const grouped = groupByFamily([{ modelId: "a/b", tokens: null, spendUsd: null }]);
    expect(grouped[0]!.spendUsd).toBe(0);
    expect(grouped[0]!.tokens).toBe(0);
  });
});

describe("familySeries", () => {
  const point = (date: string, spend: Record<string, number>) => ({
    date,
    spendByModel: spend,
    tokensByModel: Object.fromEntries(Object.entries(spend).map(([k, v]) => [k, v * 10])),
  });
  const points = [
    point("2026-08-03", { "anthropic/claude-opus-5": 100, "anthropic/claude-opus-4.8": 50, "openai/gpt-5.6-sol": 90, "x-ai/grok-4.6": 10 }),
    point("2026-08-10", { "anthropic/claude-opus-5": 200, "openai/gpt-5.6-sol": 80, "x-ai/grok-4.6": 5 }),
  ];

  it("stacks families over time and folds the tail into Others", () => {
    const { dates, series } = familySeries(points, "spend", 2);
    expect(dates).toEqual(["2026-08-03", "2026-08-10"]);
    expect(series.map((s) => s.key)).toEqual(["claude-opus", "openai/gpt-5.6-sol", "__others"]);
    expect(series[0]!.values).toEqual([150, 200]);
    expect(series[1]!.values).toEqual([90, 80]);
    expect(series[2]!.values).toEqual([10, 5]);
  });

  it("fills a bucket where a family was silent with 0, not a gap", () => {
    const { series } = familySeries(
      [point("2026-08-03", { "z-ai/glm-5.2": 5 }), point("2026-08-10", { "anthropic/claude-opus-5": 7 })],
      "spend",
      5,
    );
    expect(series.find((s) => s.key === "glm-5.2-5.3")!.values).toEqual([5, 0]);
  });

  it("reads tokens when asked for tokens", () => {
    const { series } = familySeries(points, "tokens", 1);
    expect(series[0]!.values).toEqual([1500, 2000]);
  });

  it("shortens a slug label to the model half", () => {
    const { series } = familySeries(points, "spend", 3);
    expect(series.map((s) => s.label)).toEqual(["Claude Opus", "gpt-5.6-sol", "grok-4.6"]);
  });
});
