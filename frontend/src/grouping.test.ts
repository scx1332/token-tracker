import { describe, expect, it } from "bun:test";
import { classOf, groupingByKey, labOf, originOf, GROUPINGS } from "./grouping";
import { familySeries, groupByFamily } from "./family";

describe("labOf", () => {
  it("names the lab off the author segment, aliases included", () => {
    expect(labOf("anthropic/claude-opus-5").label).toBe("Anthropic");
    expect(labOf("x-ai/grok-4.6").label).toBe("xAI");
    expect(labOf("meta-llama/llama-4").key).toBe(labOf("meta/muse-spark-1.3").key);
    expect(labOf("z-ai/glm-5.3").label).toBe("Z.ai");
  });

  it("gives an unknown author its own row rather than hiding it", () => {
    expect(labOf("newlab/model-1").label).toBe("newlab");
  });
});

describe("originOf", () => {
  it("places the labs", () => {
    expect(originOf("openai/gpt-5.6-sol").label).toBe("USA");
    expect(originOf("deepseek/deepseek-v4-pro").label).toBe("China");
    expect(originOf("moonshotai/kimi-k3").label).toBe("China");
    expect(originOf("tencent/hy4-preview").label).toBe("China");
    expect(originOf("mistralai/mistral-large").label).toBe("Europe");
    expect(originOf("upstage/solar-pro4").label).toBe("Rest of world");
    expect(originOf("unknown/thing").label).toBe("Rest of world");
  });
});

describe("classOf", () => {
  it("follows the GPT-5.6 tier names", () => {
    expect(classOf("openai/gpt-5.6-luna")).toBe("Luna");
    expect(classOf("openai/gpt-5.6-luna-pro")).toBe("Luna");
    expect(classOf("openai/gpt-5.6-terra")).toBe("Terra");
    expect(classOf("openai/gpt-5.6-sol")).toBe("Sol");
    expect(classOf("openai/gpt-5.6-sol-pro")).toBe("Sol");
    expect(classOf("openai/gpt-5.5-pro")).toBe("Top");
    expect(classOf("openai/gpt-5.5")).toBe("Sol");
    expect(classOf("openai/gpt-5.4-mini")).toBe("Luna");
  });

  it("tiers the Anthropic and Google lines", () => {
    expect(classOf("anthropic/claude-fable-5.1")).toBe("Top");
    expect(classOf("anthropic/claude-opus-5")).toBe("Sol");
    expect(classOf("anthropic/claude-sonnet-5")).toBe("Terra");
    expect(classOf("anthropic/claude-haiku-4.5")).toBe("Luna");
    expect(classOf("google/gemini-3.1-pro-preview")).toBe("Sol");
    expect(classOf("google/gemini-3.7-flash")).toBe("Terra");
    expect(classOf("google/gemini-3.1-flash-lite")).toBe("Luna");
  });

  it("tiers the Chinese labs", () => {
    expect(classOf("moonshotai/kimi-k3")).toBe("Sol");
    expect(classOf("z-ai/glm-5.3")).toBe("Terra");
    expect(classOf("z-ai/glm-5.3-flash")).toBe("Luna");
    expect(classOf("deepseek/deepseek-v4-flash-0731")).toBe("Luna");
    expect(classOf("deepseek/deepseek-v4-pro")).toBe("Sol");
    expect(classOf("qwen/qwen3.8-max")).toBe("Sol");
    expect(classOf("tencent/hy4-preview")).toBe("Terra");
  });

  it("reads the tail off its slug", () => {
    expect(classOf("acme/thing-mini")).toBe("Luna");
    expect(classOf("acme/thing-7b-instruct")).toBe("Luna");
    expect(classOf("acme/thing-pro")).toBe("Sol");
    expect(classOf("acme/thing")).toBe("Terra");
  });
});

describe("board groupings", () => {
  const rows = [
    { modelId: "anthropic/claude-opus-5", name: "Claude Opus 5", tokens: 10, spendUsd: 400 },
    { modelId: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8", tokens: 5, spendUsd: 100 },
    { modelId: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", tokens: 20, spendUsd: 200 },
    { modelId: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", tokens: 20, spendUsd: 300 },
    { modelId: "z-ai/glm-5.3", name: "GLM 5.3", tokens: 40, spendUsd: 150 },
  ];

  it("a lab row unfolds into product lines, not slugs", () => {
    const lab = groupByFamily(rows, groupingByKey("lab"));
    expect(lab.map((g) => g.label)).toEqual(["Anthropic", "OpenAI", "Z.ai"]);
    expect(lab[0]!.grouped).toBe(true);
    expect(lab[0]!.parts.map((p) => `${p.label}:${p.spendUsd}`)).toEqual(["Claude Opus:500", "Claude Sonnet:200"]);
    // A lone model in a lab is named by its display name.
    expect(lab[1]!.parts[0]!.label).toBe("GPT-5.6 Sol");
  });

  it("origin sums a whole country", () => {
    const origin = groupByFamily(rows, groupingByKey("origin"));
    expect(origin.map((g) => `${g.label}:${g.spendUsd}`)).toEqual(["USA:1000", "China:150"]);
  });

  it("class buckets by tier and keeps the tier order stable in its keys", () => {
    const cls = groupByFamily(rows, groupingByKey("class"));
    expect(cls.map((g) => g.label)).toEqual(["High · Sol class", "Medium · Terra class"]);
    expect(cls[1]!.parts.map((p) => p.label)).toEqual(["Claude Sonnet", "GLM 5.2 + 5.3"]);
  });

  it("the stack unfolds a lab band into product lines", () => {
    const points = [
      { date: "2026-08-03", spendByModel: { "anthropic/claude-opus-5": 60, "anthropic/claude-sonnet-5": 40, "openai/gpt-5.6-sol": 10 }, tokensByModel: {} },
    ];
    const { series } = familySeries(points, "spend", 5, groupingByKey("lab"));
    expect(series[0]!.label).toBe("Anthropic");
    expect(series[0]!.members.map((m) => m.label)).toEqual(["Claude Opus", "Claude Sonnet"]);
    // No display names in the race payload: a lone model shows its slug's model half.
    expect(series[1]!.members.map((m) => m.label)).toEqual(["gpt-5.6-sol"]);
  });

  it("falls back to product lines for an unknown key", () => {
    expect(groupingByKey("nope").key).toBe("family");
    expect(GROUPINGS.map((g) => g.key)).toEqual(["family", "lab", "origin", "class"]);
  });
});
