import { describe, expect, it } from "bun:test";
import { fleetBlendedRate, rankAppsByDaySpend } from "./apps";
import type { AppSpendRow, AppUsage } from "./api";

function dayApp(appId: number | null, title: string, tokens: number): AppUsage {
  return { appId, title, url: null, tokens, requests: null, rank: null };
}

function spendApp(appId: number | null, title: string, spendUsd: number, tokens: number): AppSpendRow {
  return { appId, title, url: null, spendUsd, tokens, topModels: [] };
}

describe("fleetBlendedRate", () => {
  it("blends dollars over tokens across the whole sweep", () => {
    // $30 over 3M tokens = $10/Mtok = 1e-5 per token.
    const rate = fleetBlendedRate([spendApp(1, "a", 10, 2_000_000), spendApp(2, "b", 20, 1_000_000)]);
    expect(rate).toBeCloseTo(30 / 3_000_000, 12);
  });

  it("returns null when the sweep has no priced tokens", () => {
    expect(fleetBlendedRate([])).toBeNull();
    expect(fleetBlendedRate([spendApp(1, "a", 0, 5)])).toBeNull();
  });
});

describe("rankAppsByDaySpend", () => {
  const sweep = [
    // Cheap model at huge volume: $1 per 1M tokens.
    spendApp(1, "Volume app", 100, 100_000_000),
    // Frontier models: $20 per 1M tokens.
    spendApp(2, "Frontier app", 200, 10_000_000),
  ];

  it("ranks by dollars, not tokens", () => {
    const rows = rankAppsByDaySpend(
      [dayApp(1, "Volume app", 10_000_000), dayApp(2, "Frontier app", 1_000_000)],
      sweep,
    );
    expect(rows.map((r) => r.title)).toEqual(["Frontier app", "Volume app"]);
    expect(rows[0]!.spendUsd).toBeCloseTo(20, 9); // 1M tok × $20/Mtok
    expect(rows[1]!.spendUsd).toBeCloseTo(10, 9); // 10M tok × $1/Mtok
    expect(rows.every((r) => r.rateSource === "own")).toBe(true);
  });

  it("matches on title when the day feed carries no app id", () => {
    const rows = rankAppsByDaySpend([dayApp(null, "  frontier APP ", 1_000_000)], sweep);
    expect(rows[0]!.rateSource).toBe("own");
    expect(rows[0]!.spendUsd).toBeCloseTo(20, 9);
  });

  it("falls back to the fleet rate for apps the sweep never saw", () => {
    const rows = rankAppsByDaySpend([dayApp(9, "Newcomer", 1_000_000)], sweep);
    // Fleet blend: $300 over 110M tokens.
    expect(rows[0]!.rateSource).toBe("market");
    expect(rows[0]!.spendUsd).toBeCloseTo(1_000_000 * (300 / 110_000_000), 9);
  });

  it("degrades to a token ranking when no spend sweep exists", () => {
    const rows = rankAppsByDaySpend([dayApp(1, "small", 5), dayApp(2, "big", 50)], []);
    expect(rows.map((r) => r.title)).toEqual(["big", "small"]);
    expect(rows.every((r) => r.spendUsd === null && r.rateSource === null)).toBe(true);
  });

  it("uses the fleet rate when an app is in the sweep but priced at zero", () => {
    // "Zero" is in the sweep with no dollars, so it has no rate of its own.
    const partial = [spendApp(1, "Priced", 50, 5_000_000), spendApp(2, "Zero", 0, 1_000_000)];
    const rows = rankAppsByDaySpend([dayApp(2, "Zero", 999_999_999), dayApp(1, "Priced", 1_000)], partial);
    expect(rows[0]!.title).toBe("Zero"); // fleet fallback still prices it
    expect(rows[0]!.rateSource).toBe("market");
  });
});
