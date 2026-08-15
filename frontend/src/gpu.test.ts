import { test, expect, describe } from "bun:test";
import {
  groupDailyByGpu,
  lastWindow,
  hourOfDayProfile,
  rebase,
  buildComparison,
  buildHourlyComparison,
  totalChangePct,
} from "./gpu";
import type { GpuDailyRow, PriceIndexPoint } from "./api";

function daily(partial: Partial<GpuDailyRow> & { date: string }): GpuDailyRow {
  return {
    gpuName: "B200",
    minUsd: 4,
    medianUsd: 5,
    p25Usd: 4.5,
    p75Usd: 6,
    gpusAvailable: 40,
    samples: 24,
    ...partial,
  };
}

describe("groupDailyByGpu", () => {
  test("splits by GPU and sorts each series by date", () => {
    const grouped = groupDailyByGpu([
      daily({ gpuName: "B200", date: "2026-08-13" }),
      daily({ gpuName: "B300", date: "2026-08-12" }),
      daily({ gpuName: "B200", date: "2026-08-11" }),
    ]);
    expect([...grouped.keys()].sort()).toEqual(["B200", "B300"]);
    expect(grouped.get("B200")!.map((r) => r.date)).toEqual(["2026-08-11", "2026-08-13"]);
  });
});

describe("lastWindow", () => {
  const now = Date.parse("2026-08-13T12:00:00.000Z");
  test("keeps rows inside the trailing window, inclusive of the edge", () => {
    const rows = [
      { capturedAt: "2026-08-10T11:00:00.000Z" }, // 73h ago — out
      { capturedAt: "2026-08-10T12:00:00.000Z" }, // exactly 72h — in
      { capturedAt: "2026-08-13T11:45:00.000Z" }, // in
    ];
    expect(lastWindow(rows, 72, now).map((r) => r.capturedAt)).toEqual([
      "2026-08-10T12:00:00.000Z",
      "2026-08-13T11:45:00.000Z",
    ]);
  });

  test("unparseable timestamps are dropped, not kept by accident", () => {
    expect(lastWindow([{ capturedAt: "garbage" }], 72, now)).toEqual([]);
  });
});

describe("hourOfDayProfile", () => {
  const at = (day: number, hour: number) =>
    `2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:15:00.000Z`;

  test("groups by UTC hour and takes the median per hour", () => {
    const profile = hourOfDayProfile([
      { at: at(10, 4), value: 10 },
      { at: at(11, 4), value: 20 },
      { at: at(12, 4), value: 30 },
      { at: at(10, 14), value: 40 },
    ]);
    expect(profile).toHaveLength(24);
    expect(profile[4]!.median).toBe(20);
    expect(profile[4]!.samples).toBe(3);
    expect(profile[14]!.median).toBe(40);
    expect(profile[0]!.median).toBeNull();
    expect(profile[0]!.samples).toBe(0);
  });

  test("index is percent of a typical hour, hours weighted equally", () => {
    // Hour 4 has many samples at 10, hour 14 one sample at 30 → baseline is
    // the median of {10, 30} = 20, NOT dragged toward the oversampled hour.
    const profile = hourOfDayProfile([
      { at: at(10, 4), value: 10 },
      { at: at(11, 4), value: 10 },
      { at: at(12, 4), value: 10 },
      { at: at(13, 4), value: 10 },
      { at: at(10, 14), value: 30 },
    ]);
    expect(profile[4]!.index).toBeCloseTo(50, 9);
    expect(profile[14]!.index).toBeCloseTo(150, 9);
  });

  test("zero is a real value (depth can be zero), indexed as 0 not null", () => {
    const profile = hourOfDayProfile([
      { at: at(10, 2), value: 0 },
      { at: at(10, 12), value: 50 },
      { at: at(10, 18), value: 50 },
    ]);
    expect(profile[2]!.median).toBe(0);
    expect(profile[2]!.index).toBe(0);
  });

  test("an all-zero series cannot be normalized — indexes are null", () => {
    const profile = hourOfDayProfile([
      { at: at(10, 2), value: 0 },
      { at: at(10, 3), value: 0 },
    ]);
    expect(profile[2]!.median).toBe(0);
    expect(profile[2]!.index).toBeNull();
  });

  test("nulls and garbage timestamps are skipped", () => {
    const profile = hourOfDayProfile([
      { at: at(10, 5), value: null },
      { at: "not-a-date", value: 10 },
      { at: at(10, 5), value: 12 },
    ]);
    expect(profile[5]!.median).toBe(12);
    expect(profile[5]!.samples).toBe(1);
  });

  test("empty input yields 24 empty hours", () => {
    const profile = hourOfDayProfile([]);
    expect(profile).toHaveLength(24);
    expect(profile.every((p) => p.median === null && p.index === null && p.samples === 0)).toBe(true);
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
  const gpuDaily = [
    daily({ date: "2026-08-12", medianUsd: 5, minUsd: 4 }),
    daily({ date: "2026-08-13", medianUsd: 6, minUsd: 3 }),
  ];

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
    const c = buildComparison(priceIndex, [daily({ date: "2026-09-01" })]);
    expect(c.dates).toEqual([]);
    expect(c.tokenIndex).toEqual([]);
  });
});

describe("buildHourlyComparison", () => {
  const snap = (at: string, v: number | null) => ({
    capturedAt: at,
    usageWeightedPromptUsdPerMtok: v,
  });
  const sweep = (at: string, med: number, min = med / 2) => ({
    capturedAt: at,
    minUsd: min,
    medianUsd: med,
  });

  test("aligns on shared UTC hours, medianing the sweeps within each hour", () => {
    const c = buildHourlyComparison(
      [snap("2026-08-15T09:57:00Z", 0.8), snap("2026-08-15T10:58:00Z", 0.4)],
      [
        sweep("2026-08-15T09:05:00Z", 5),
        sweep("2026-08-15T09:20:00Z", 7),
        sweep("2026-08-15T09:35:00Z", 6),
        sweep("2026-08-15T10:05:00Z", 9),
        sweep("2026-08-15T11:05:00Z", 9), // no token snapshot this hour → dropped
      ],
    );
    expect(c.dates).toEqual(["2026-08-15T09:00", "2026-08-15T10:00"]);
    expect(c.gpuRaw).toEqual([6, 9]);
    expect(c.tokenRaw).toEqual([0.8, 0.4]);
    expect(c.tokenIndex).toEqual([100, 50]);
    expect(c.gpuIndex[1]).toBeCloseTo(150, 9);
  });

  test("honours the chosen GPU metric", () => {
    const c = buildHourlyComparison(
      [snap("2026-08-15T09:57:00Z", 0.8)],
      [sweep("2026-08-15T09:05:00Z", 5, 2)],
      "minUsd",
    );
    expect(c.gpuRaw).toEqual([2]);
  });

  test("null values and unparsable stamps contribute nothing", () => {
    const c = buildHourlyComparison(
      [snap("2026-08-15T09:57:00Z", null), snap("not a date", 1)],
      [sweep("2026-08-15T09:05:00Z", 5)],
    );
    expect(c.dates).toEqual([]);
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
