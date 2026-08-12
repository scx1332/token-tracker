import { test, expect, describe } from "bun:test";
import { parseRankingsRecords } from "./usage";

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
