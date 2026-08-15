import { test, expect, describe } from "bun:test";
import { collapseProviderEndpoints, parseEndpointStats, parseRankingsRecords } from "./usage";

describe("parseRankingsRecords", () => {
  const raw = {
    data: [
      {
        date: "2026-08-11 00:00:00",
        model_permaslug: "z-ai/glm-5.2-20260616",
        variant: "standard",
        total_prompt_tokens: 613115419801,
        total_completion_tokens: 9253026063,
        total_native_tokens_reasoning: 0,
        count: 152236,
      },
      {
        date: "2026-08-11 00:00:00",
        model_permaslug: "z-ai/glm-5.2-20260616",
        variant: "batch",
        total_prompt_tokens: 16742625,
        total_completion_tokens: 16991094,
        count: 12,
      },
      { date: "2026-08-11 00:00:00", variant: "standard", total_prompt_tokens: 1 }, // no permaslug -> skipped
    ],
  };

  const rows = parseRankingsRecords(raw);

  test("skips records without a permaslug", () => {
    expect(rows).toHaveLength(2);
  });
  test("tokens is prompt + completion", () => {
    expect(rows[0]!.tokens).toBe(613115419801 + 9253026063);
    expect(rows[0]!.promptTokens).toBe(613115419801);
    expect(rows[0]!.completionTokens).toBe(9253026063);
  });
  test("slices the date to YYYY-MM-DD and keeps the variant", () => {
    expect(rows[0]!.date).toBe("2026-08-11");
    expect(rows[1]!.variant).toBe("batch");
  });
  test("requests come from count", () => {
    expect(rows[0]!.requests).toBe(152236);
  });
  test("accepts a bare array too", () => {
    expect(parseRankingsRecords(raw.data)).toHaveLength(2);
  });
  test("empty / malformed input yields no rows", () => {
    expect(parseRankingsRecords(null)).toEqual([]);
    expect(parseRankingsRecords({})).toEqual([]);
  });
});

describe("parseEndpointStats", () => {
  const ep = (provider: string, count: number, thr: number, extra: object = {}) => ({
    provider_display_name: provider,
    stats: { request_count: count, window_minutes: 30, p50_throughput: thr, p50_latency: 1000 },
    ...extra,
  });

  test("aggregates endpoints per provider, busiest first", () => {
    const rows = parseEndpointStats({ data: [ep("A", 100, 20), ep("B", 500, 40), ep("A", 300, 55)] });
    expect(rows.map((r) => r.provider)).toEqual(["B", "A"]);
    expect(rows[1]!.requestCount).toBe(400); // 100 + 300 summed
    expect(rows[1]!.p50Throughput).toBe(55); // busiest A endpoint wins
    expect(rows[0]!.windowMinutes).toBe(30);
  });

  test("falls back to provider_name and skips stat-less endpoints", () => {
    const rows = parseEndpointStats({
      data: [
        { provider_name: "C", stats: { request_count: 7 } },
        { provider_display_name: "NoStats" },
      ],
    });
    expect(rows).toEqual([
      { provider: "C", requestCount: 7, windowMinutes: null, p50Throughput: null, p50Latency: null },
    ]);
  });

  test("malformed input yields no rows", () => {
    expect(parseEndpointStats(null)).toEqual([]);
    expect(parseEndpointStats({ data: "nope" })).toEqual([]);
  });
});

describe("collapseProviderEndpoints", () => {
  const p = (
    slug: string,
    name: string,
    totalTokens: number | null,
    effInputPerMtok: number | null,
    effOutputPerMtok: number | null,
  ) => ({ slug, name, totalTokens, effInputPerMtok, effOutputPerMtok });

  // The real gemini-3.6-flash payload: two google-vertex endpoints, the second
  // a 444M-token side region quoting 4x the price of the 61B-token main one.
  const gemini = [
    p("google-vertex", "Google Vertex", 61_235_448_663, 0.2015997053634887, 3.7507542009642636),
    p("google-ai-studio", "Google AI Studio", 55_800_622_829, 0.1172083048790646, 3.728426154335255),
    p("google-vertex", "Google Vertex (US)", 444_122, 0.8233626192504854, 4.100796484482285),
  ];

  test("one row per slug, tokens summed, first-seen order kept", () => {
    const rows = collapseProviderEndpoints(gemini);
    expect(rows.map((r) => r.slug)).toEqual(["google-vertex", "google-ai-studio"]);
    expect(rows[0]!.totalTokens).toBe(61_235_448_663 + 444_122);
  });

  test("rates blend by volume, so a tiny side endpoint barely moves them", () => {
    const [vertex] = collapseProviderEndpoints(gemini);
    // Within a whisker of the main endpoint's $0.2016 — not the $0.8234 outlier,
    // which is what last-endpoint-wins used to charge the whole slug.
    expect(vertex!.effInputPerMtok).toBeCloseTo(0.2016, 4);
    expect(vertex!.effInputPerMtok!).toBeLessThan(0.21);
    expect(vertex!.effOutputPerMtok).toBeCloseTo(3.7508, 4);
  });

  test("collapsed rates land on OpenRouter's own model-level blend", () => {
    const rows = collapseProviderEndpoints(gemini);
    const weighted =
      rows.reduce((s, r) => s + r.effInputPerMtok! * r.totalTokens!, 0) /
      rows.reduce((s, r) => s + r.totalTokens!, 0);
    // Its weightedInputPrice weights by prompt volume, ours by total, so the
    // two agree to a fraction of a percent rather than exactly.
    expect(Math.abs(weighted / 0.16112896284065775 - 1)).toBeLessThan(0.005);
  });

  test("busiest endpoint names the provider", () => {
    expect(collapseProviderEndpoints(gemini)[0]!.name).toBe("Google Vertex");
  });

  test("without volume the rates fall back to a plain mean", () => {
    const rows = collapseProviderEndpoints([
      p("azure", "Azure", null, 1, 10),
      p("azure", "Azure EU", 0, 3, 30),
    ]);
    expect(rows[0]!.effInputPerMtok).toBe(2);
    expect(rows[0]!.effOutputPerMtok).toBe(20);
    expect(rows[0]!.totalTokens).toBe(0);
  });

  test("input and output blend independently, missing rates stay null", () => {
    const rows = collapseProviderEndpoints([
      p("x", "X", 100, 2, null),
      p("x", "X2", 300, null, 8),
      p("y", "Y", 50, null, null),
    ]);
    expect(rows[0]!.effInputPerMtok).toBe(2);
    expect(rows[0]!.effOutputPerMtok).toBe(8);
    expect(rows[1]!.effInputPerMtok).toBeNull();
    expect(rows[1]!.totalTokens).toBe(50);
  });

  test("single-endpoint providers and empty input pass through unchanged", () => {
    const one = [p("openai", "OpenAI", 12, 1.5, 20)];
    expect(collapseProviderEndpoints(one)).toEqual(one);
    expect(collapseProviderEndpoints([])).toEqual([]);
  });
});
