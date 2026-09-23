import { describe, expect, it } from "bun:test";
import { breakdownAt, familyOf, familySeries, groupByFamily } from "./family";

const key = (id: string) => familyOf(id).key;

describe("familyOf", () => {
  it("groups new serving variants without merging distinct models", () => {
    for (const tier of ["sol", "luna"]) {
      for (const suffix of ["", ":batch", "-pro", "-pro:batch"]) {
        expect(key(`openai/gpt-6-${tier}${suffix}`)).toBe(`gpt-${tier}`);
      }
    }
    expect(key("anthropic/claude-opus-5.5:batch")).toBe("claude-opus");
    expect(key("xiaomi/mimo-v2.6-pro")).toBe("mimo-v2.6-pro");
    expect(key("xiaomi/mimo-v2.6-pro-ultraspeed")).toBe("mimo-v2.6-pro");
    expect(key("xiaomi/mimo-v2.6-flash")).toBe("xiaomi/mimo-v2.6-flash");
    expect(key("qwen/qwen3.8-omni-flash")).toBe("qwen/qwen3.8-omni-flash");
    expect(key("z-ai/glm-5.3-flashx")).toBe("glm-flash");
  });

  it("keeps other Grok product lines outside the flagship family", () => {
    for (const id of ["x-ai/grok-4-fast", "x-ai/grok-4.7-fast", "x-ai/grok-build-0.1", "x-ai/grok-4.3"]) {
      expect(key(id)).toBe(id);
    }
    expect(key("x-ai/grok-4.7:batch")).toBe("grok");
  });

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

  it("joins GPT-6 Astra and Astra Pro into one line", () => {
    expect(key("openai/gpt-6-astra")).toBe("gpt-6-astra");
    expect(key("openai/gpt-6-astra-pro")).toBe("gpt-6-astra");
    expect(key("openai/gpt-6-astra-pro:batch")).toBe("gpt-6-astra");
    // Other GPT lines stay their own rows.
    expect(key("openai/gpt-5.6-sol")).toBe("gpt-sol");
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
    expect(key("openai/gpt-5.6-sol")).toBe("gpt-sol");
    expect(key("openai/gpt-5.6-luna")).toBe("gpt-luna");
    expect(familyOf("openai/gpt-5.6-sol", "OpenAI: GPT-5.6 Sol").label).toBe("GPT Sol");
  });
});

describe("groupByFamily", () => {
  for (const [family, label, ids] of [
    ...["sol", "luna"].map((tier) => [
      `gpt-${tier}`, tier === "sol" ? "GPT Sol" : "GPT Luna",
      ["5.6", "6"].flatMap((version) =>
        ["", "-pro", ":batch", "-pro:batch"].map((suffix) => `openai/gpt-${version}-${tier}${suffix}`),
      ),
    ] as const),
    ["grok", "Grok", ["x-ai/grok-4.5", "x-ai/grok-4.6", "x-ai/grok-4.7"]] as const,
  ]) {
    it(`combines ${label} generations in board totals and historical stacks`, () => {
      const rows = ids.map((modelId) => ({ modelId, tokens: 100, spendUsd: 10 }));
      const grouped = groupByFamily(rows);
      expect(grouped).toHaveLength(1);
      expect(grouped[0]!.label).toBe(label);
      expect(grouped[0]!.tokens).toBe(ids.length * 100);
      expect(grouped[0]!.spendUsd).toBe(ids.length * 10);
      expect(grouped[0]!.members).toHaveLength(ids.length);
      for (const mode of ["spend", "tokens"] as const) {
        const { series } = familySeries([{
          date: "2026-09-22",
          spendByModel: Object.fromEntries(ids.map((id) => [id, 10])),
          tokensByModel: Object.fromEntries(ids.map((id) => [id, 100])),
        }], mode, 10);
        expect(series).toHaveLength(1);
        expect(series[0]!.key).toBe(family);
        expect(series[0]!.values).toEqual([ids.length * (mode === "spend" ? 10 : 100)]);
      }
    });
  }

  const rows = [
    { modelId: "anthropic/claude-opus-5", name: "Claude Opus 5", tokens: 10, spendUsd: 400 },
    { modelId: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8", tokens: 5, spendUsd: 130 },
    { modelId: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", tokens: 20, spendUsd: 325 },
    { modelId: "deepseek/deepseek-v4-flash-0731", name: "V4 Flash 0731", tokens: 3, spendUsd: 80 },
    { modelId: "deepseek/deepseek-v4-flash", name: "V4 Flash", tokens: 2, spendUsd: 40 },
  ];

  it("sums a family's spend and tokens and ranks by the total", () => {
    const grouped = groupByFamily(rows);
    expect(grouped.map((g) => g.key)).toEqual(["claude-opus", "gpt-sol", "deepseek-v4-flash"]);
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

  it("keeps the product-line label when only one version has usage", () => {
    expect(groupByFamily(rows)[1]!.label).toBe("GPT Sol");
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
    expect(series.map((s) => s.key)).toEqual(["claude-opus", "gpt-sol", "__others"]);
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
    expect(series.map((s) => s.label)).toEqual(["Claude Opus", "GPT Sol", "Grok"]);
  });
});

describe("breakdownAt", () => {
  const fmt = (v: number) => `$${v}`;
  const points = [
    {
      date: "2026-08-03",
      spendByModel: { "anthropic/claude-opus-5": 60, "anthropic/claude-opus-4.8": 30, "anthropic/claude-opus-4.7": 10, "z-ai/glm-5.2": 5 },
      tokensByModel: {},
    },
    {
      date: "2026-08-10",
      spendByModel: { "anthropic/claude-opus-5": 100, "z-ai/glm-5.2": 5 },
      tokensByModel: {},
    },
  ];
  const opus = familySeries(points, "spend", 5).series.find((s) => s.key === "claude-opus")!;

  it("splits a band into its members with shares of that bucket", () => {
    expect(breakdownAt(opus, 0, fmt)).toEqual([
      "claude-opus-5 $60 · 60%",
      "claude-opus-4.8 $30 · 30%",
      "claude-opus-4.7 $10 · 10%",
    ]);
  });

  it("drops members that were silent, and still names the one that ran", () => {
    expect(breakdownAt(opus, 1, fmt)).toEqual(["claude-opus-5 $100 · 100%"]);
  });

  it("caps the rows and pools the tail", () => {
    const many = {
      key: "k",
      label: "k",
      grouped: true,
      values: [100],
      members: [50, 20, 10, 8, 5, 4, 2, 1].map((v, i) => ({ label: `m${i}`, values: [v] })),
    };
    const lines = breakdownAt(many, 0, fmt, 3);
    expect(lines).toEqual(["m0 $50 · 50%", "m1 $20 · 20%", "m2 $10 · 10%", "+5 more $20 · 20%"]);
  });

  it("unfolds a product line holding a single model, so it reads like the rest", () => {
    const glm = familySeries(points, "spend", 5).series.find((s) => s.key === "glm-5.2-5.3")!;
    expect(glm.grouped).toBe(true);
    expect(breakdownAt(glm, 0, fmt)).toEqual(["glm-5.2 $5 · 100%"]);
  });

  it("says nothing for a lone model or an empty bucket", () => {
    const solo = familySeries(points, "spend", 5).series.find((s) => s.key === "x-ai/grok-4.6");
    expect(solo).toBeUndefined();
    expect(breakdownAt({ key: "k", label: "k", grouped: false, values: [5], members: [] }, 0, fmt)).toEqual([]);
    expect(breakdownAt({ key: "k", label: "k", grouped: true, values: [0], members: [] }, 0, fmt)).toEqual([]);
  });
});
