import { test, expect, describe } from "bun:test";
import {
  utcDay,
  toDailyPoints,
  groupByGpu,
  rebase,
  buildComparison,
  totalChangePct,
} from "./gpu";
import type { GpuPriceRow, PriceIndexPoint } from "./api";

function row(partial: Partial<GpuPriceRow> & { capturedAt: string }): GpuPriceRow {
  return {
    gpuName: "B200",
    offers: 10,
    gpusAvailable: 40,
    minUsd: 4,
    p25Usd: 4.5,
    medianUsd: 5,
    p75Usd: 6,
    maxUsd: 7,
    meanUsd: 5.2,
    supplyWeightedUsd: 5.3,
    minBidUsd: 3,
    verifiedOffers: 5,
    verifiedGpusAvailable: 20,
    verifiedMinUsd: 4.5,
    verifiedMedianUsd: 5,
    ...partial,
  };
}

describe("utcDay", () => {
  test("takes the UTC calendar day", () => {
    expect(utcDay("2026-08-13T23:59:00.000Z")).toBe("2026-08-13");
  });
});

describe("toDailyPoints", () => {
  test("groups hourly snapshots into one point per day, sorted", () => {
    const points = toDailyPoints([
      row({ capturedAt: "2026-08-14T01:00:00.000Z" }),
      row({ capturedAt: "2026-08-13T01:00:00.000Z" }),
      row({ capturedAt: "2026-08-13T05:00:00.000Z" }),
    ]);
    expect(points.map((p) => p.date)).toEqual(["2026-08-13", "2026-08-14"]);
    expect(points[0]!.samples).toBe(2);
    expect(points[1]!.samples).toBe(1);
  });

  test("daily min is the best price reachable at any hour", () => {
    const points = toDailyPoints([
      row({ capturedAt: "2026-08-13T01:00:00.000Z", minUsd: 4 }),
      row({ capturedAt: "2026-08-13T02:00:00.000Z", minUsd: 2.5 }),
      row({ capturedAt: "2026-08-13T03:00:00.000Z", minUsd: 3 }),
    ]);
    expect(points[0]!.minUsd).toBe(2.5);
  });

  test("daily median is the median of hourly medians, so deep hours don't outvote thin ones", () => {
    const points = toDailyPoints([
      row({ capturedAt: "2026-08-13T01:00:00.000Z", medianUsd: 5, offers: 1 }),
      row({ capturedAt: "2026-08-13T02:00:00.000Z", medianUsd: 7, offers: 500 }),
      row({ capturedAt: "2026-08-13T03:00:00.000Z", medianUsd: 6, offers: 1 }),
    ]);
    expect(points[0]!.medianUsd).toBe(6);
  });

  test("depth reports the day's peak availability", () => {
    const points = toDailyPoints([
      row({ capturedAt: "2026-08-13T01:00:00.000Z", gpusAvailable: 30 }),
      row({ capturedAt: "2026-08-13T02:00:00.000Z", gpusAvailable: 90 }),
    ]);
    expect(points[0]!.gpusAvailable).toBe(90);
  });

  test("a day where the market was empty stays null, never NaN", () => {
    const points = toDailyPoints([
      row({ capturedAt: "2026-08-13T01:00:00.000Z", minUsd: null, medianUsd: null, p25Usd: null, p75Usd: null }),
    ]);
    expect(points[0]!.minUsd).toBeNull();
    expect(points[0]!.medianUsd).toBeNull();
  });

  test("nulls are skipped rather than dragging the day's stats down", () => {
    const points = toDailyPoints([
      row({ capturedAt: "2026-08-13T01:00:00.000Z", minUsd: null, medianUsd: null }),
      row({ capturedAt: "2026-08-13T02:00:00.000Z", minUsd: 3, medianUsd: 4 }),
    ]);
    expect(points[0]!.minUsd).toBe(3);
    expect(points[0]!.medianUsd).toBe(4);
  });

  test("empty input yields no points", () => {
    expect(toDailyPoints([])).toEqual([]);
  });
});

describe("groupByGpu", () => {
  test("splits by GPU and sorts each series by time", () => {
    const grouped = groupByGpu([
      row({ gpuName: "B200", capturedAt: "2026-08-13T05:00:00.000Z" }),
      row({ gpuName: "B300", capturedAt: "2026-08-13T01:00:00.000Z" }),
      row({ gpuName: "B200", capturedAt: "2026-08-13T01:00:00.000Z" }),
    ]);
    expect([...grouped.keys()].sort()).toEqual(["B200", "B300"]);
    expect(grouped.get("B200")!.map((r) => r.capturedAt)).toEqual([
      "2026-08-13T01:00:00.000Z",
      "2026-08-13T05:00:00.000Z",
    ]);
  });
});

describe("rebase", () => {
  test("indexes to 100 at the first usable value", () => {
    expect(rebase([4, 5, 2])).toEqual([100, 125, 50]);
  });

  test("leading nulls stay null and the base is the first real number", () => {
    expect(rebase([null, 4, 8])).toEqual([null, 100, 200]);
  });

  test("interior nulls stay null without shifting the base", () => {
    expect(rebase([4, null, 8])).toEqual([100, null, 200]);
  });

  test("zero is missing data, not a price: it never becomes the base", () => {
    expect(rebase([0, 5])).toEqual([null, 100]);
  });

  test("an interior zero is nulled rather than drawn as a crash to the axis", () => {
    expect(rebase([4, 0, 8])).toEqual([100, null, 200]);
  });

  test("negatives are nonsense for a price and are dropped too", () => {
    expect(rebase([-1, 4])).toEqual([null, 100]);
  });

  test("all-null input stays all-null", () => {
    expect(rebase([null, null])).toEqual([null, null]);
    expect(rebase([0, 0])).toEqual([null, null]);
    expect(rebase([])).toEqual([]);
  });
});

describe("buildComparison", () => {
  const priceIndex: PriceIndexPoint[] = [
    { date: "2026-08-11", weightedUsdPerMtok: 0.5, medianUsdPerMtok: 0.6 },
    { date: "2026-08-12", weightedUsdPerMtok: 0.4, medianUsdPerMtok: 0.5 },
    { date: "2026-08-13", weightedUsdPerMtok: 0.25, medianUsdPerMtok: 0.4 },
  ];
  const gpuDaily = toDailyPoints([
    row({ capturedAt: "2026-08-12T01:00:00.000Z", medianUsd: 5, minUsd: 4 }),
    row({ capturedAt: "2026-08-13T01:00:00.000Z", medianUsd: 6, minUsd: 3 }),
  ]);

  test("restricts the axis to dates both series cover", () => {
    const c = buildComparison(priceIndex, gpuDaily);
    expect(c.dates).toEqual(["2026-08-12", "2026-08-13"]);
  });

  test("both series start at 100 so trends are directly comparable", () => {
    const c = buildComparison(priceIndex, gpuDaily);
    expect(c.tokenIndex[0]).toBe(100);
    expect(c.gpuIndex[0]).toBe(100);
    // Tokens fell 0.40 -> 0.25 (-37.5%) while GPU median rose 5 -> 6 (+20%).
    expect(c.tokenIndex[1]).toBeCloseTo(62.5, 9);
    expect(c.gpuIndex[1]).toBeCloseTo(120, 9);
  });

  test("keeps raw values in their own units for tooltips", () => {
    const c = buildComparison(priceIndex, gpuDaily);
    expect(c.tokenRaw).toEqual([0.4, 0.25]);
    expect(c.gpuRaw).toEqual([5, 6]);
  });

  test("honours the chosen GPU metric", () => {
    const c = buildComparison(priceIndex, gpuDaily, "minUsd");
    expect(c.gpuRaw).toEqual([4, 3]);
    expect(c.gpuIndex[1]).toBeCloseTo(75, 9);
  });

  test("no overlap yields an empty axis rather than a misleading stub", () => {
    const c = buildComparison(priceIndex, toDailyPoints([row({ capturedAt: "2026-09-01T01:00:00.000Z" })]));
    expect(c.dates).toEqual([]);
    expect(c.tokenIndex).toEqual([]);
  });
});

describe("totalChangePct", () => {
  test("measures first to last, ignoring nulls", () => {
    expect(totalChangePct([null, 4, null, 5])).toBeCloseTo(25, 9);
    expect(totalChangePct([10, 5])).toBeCloseTo(-50, 9);
  });

  test("needs two points and a non-zero base", () => {
    expect(totalChangePct([5])).toBeNull();
    expect(totalChangePct([])).toBeNull();
    expect(totalChangePct([0, 5])).toBeNull();
  });
});
