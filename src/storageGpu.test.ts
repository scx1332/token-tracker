import { test, expect, describe, afterAll } from "bun:test";
import { createIsolatedStorage, hasPostgresForTests, closeTestPools } from "./testPostgres";
import type { GpuPriceSnapshotInsert } from "./storage";

// Self-skips without a database, keeping plain `bun test` hermetic.
const it = hasPostgresForTests() ? test : test.skip;

afterAll(async () => {
  await closeTestPools();
});

function band(gpuName: string, overrides: Partial<GpuPriceSnapshotInsert> = {}): GpuPriceSnapshotInsert {
  return {
    gpuName,
    offers: 10,
    gpusAvailable: 40,
    excludedOffers: 2,
    minUsd: 3.85,
    p25Usd: 4.1,
    medianUsd: 5.31,
    p75Usd: 6.19,
    maxUsd: 7.75,
    meanUsd: 5.4,
    supplyWeightedUsd: 5.73,
    minBidUsd: 3.07,
    verifiedOffers: 6,
    verifiedGpusAvailable: 30,
    verifiedMinUsd: 5.31,
    verifiedMedianUsd: 5.5,
    ...overrides,
  };
}

describe("Storage GPU prices (integration)", () => {
  it("round-trips a price band without losing precision", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      const at = new Date("2026-08-13T12:00:00.000Z");
      const written = await storage.insertGpuPriceSnapshots(at, [band("B200")]);
      expect(written).toBe(1);

      const series = await storage.getGpuSeries({ gpuName: "B200" });
      expect(series).toHaveLength(1);
      const row = series[0]!;
      expect(row.gpuName).toBe("B200");
      expect(row.capturedAt).toBe("2026-08-13T12:00:00.000Z");
      expect(row.minUsd).toBeCloseTo(3.85, 9);
      expect(row.medianUsd).toBeCloseTo(5.31, 9);
      expect(row.p75Usd).toBeCloseTo(6.19, 9);
      expect(row.offers).toBe(10);
      expect(row.gpusAvailable).toBe(40);
      expect(row.excludedOffers).toBe(2);
      expect(row.verifiedMinUsd).toBeCloseTo(5.31, 9);
    } finally {
      await cleanup();
    }
  });

  it("writes a whole pass in one batch and reads it back ordered by time", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      const t1 = new Date("2026-08-13T10:00:00.000Z");
      const t2 = new Date("2026-08-13T11:00:00.000Z");
      await storage.insertGpuPriceSnapshots(t2, [band("B200", { medianUsd: 6 }), band("B300")]);
      await storage.insertGpuPriceSnapshots(t1, [band("B200", { medianUsd: 5 }), band("B300")]);

      const all = await storage.getGpuSeries({});
      expect(all).toHaveLength(4);
      expect(all.map((r) => r.capturedAt)).toEqual([
        "2026-08-13T10:00:00.000Z",
        "2026-08-13T10:00:00.000Z",
        "2026-08-13T11:00:00.000Z",
        "2026-08-13T11:00:00.000Z",
      ]);

      const b200 = await storage.getGpuSeries({ gpuName: "B200" });
      expect(b200.map((r) => r.medianUsd)).toEqual([5, 6]);
    } finally {
      await cleanup();
    }
  });

  it("re-running a pass at the same instant updates rather than duplicates", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      const at = new Date("2026-08-13T12:00:00.000Z");
      await storage.insertGpuPriceSnapshots(at, [band("B200", { medianUsd: 5, offers: 10 })]);
      await storage.insertGpuPriceSnapshots(at, [band("B200", { medianUsd: 9, offers: 12 })]);

      const series = await storage.getGpuSeries({ gpuName: "B200" });
      expect(series).toHaveLength(1);
      expect(series[0]!.medianUsd).toBeCloseTo(9, 9);
      expect(series[0]!.offers).toBe(12);
    } finally {
      await cleanup();
    }
  });

  it("getGpuLatest returns the newest row per GPU, not the newest overall", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      await storage.insertGpuPriceSnapshots(new Date("2026-08-13T10:00:00.000Z"), [
        band("B200", { medianUsd: 5 }),
        band("B300", { medianUsd: 7 }),
      ]);
      // A later pass where B300 failed to fetch: its older row must still surface.
      await storage.insertGpuPriceSnapshots(new Date("2026-08-13T11:00:00.000Z"), [
        band("B200", { medianUsd: 6 }),
      ]);

      const latest = await storage.getGpuLatest();
      expect(latest).toHaveLength(2);
      const byName = new Map(latest.map((r) => [r.gpuName, r]));
      expect(byName.get("B200")!.medianUsd).toBeCloseTo(6, 9);
      expect(byName.get("B200")!.capturedAt).toBe("2026-08-13T11:00:00.000Z");
      expect(byName.get("B300")!.medianUsd).toBeCloseTo(7, 9);
      expect(byName.get("B300")!.capturedAt).toBe("2026-08-13T10:00:00.000Z");
    } finally {
      await cleanup();
    }
  });

  it("stores a dried-up market as a zero-depth row, not as missing data", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      const empty: GpuPriceSnapshotInsert = {
        gpuName: "B300",
        offers: 0,
        gpusAvailable: 0,
        excludedOffers: 0,
        minUsd: null,
        p25Usd: null,
        medianUsd: null,
        p75Usd: null,
        maxUsd: null,
        meanUsd: null,
        supplyWeightedUsd: null,
        minBidUsd: null,
        verifiedOffers: 0,
        verifiedGpusAvailable: 0,
        verifiedMinUsd: null,
        verifiedMedianUsd: null,
      };
      await storage.insertGpuPriceSnapshots(new Date("2026-08-13T12:00:00.000Z"), [empty]);

      const series = await storage.getGpuSeries({ gpuName: "B300" });
      expect(series).toHaveLength(1);
      expect(series[0]!.offers).toBe(0);
      expect(series[0]!.minUsd).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("since filters by capture time", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      await storage.insertGpuPriceSnapshots(new Date("2026-08-01T00:00:00.000Z"), [band("B200")]);
      await storage.insertGpuPriceSnapshots(new Date("2026-08-13T00:00:00.000Z"), [band("B200")]);

      const recent = await storage.getGpuSeries({ since: "2026-08-10T00:00:00.000Z" });
      expect(recent).toHaveLength(1);
      expect(recent[0]!.capturedAt).toBe("2026-08-13T00:00:00.000Z");
    } finally {
      await cleanup();
    }
  });

  it("aggregates hourly sweeps into UTC-day rows with the client's old semantics", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      // Three sweeps on Aug 12 (one late enough to test the UTC day boundary)
      // and one on Aug 13.
      await storage.insertGpuPriceSnapshots(new Date("2026-08-12T01:00:00.000Z"), [
        band("B200", { minUsd: 4.0, medianUsd: 5.0, p25Usd: 4.5, p75Usd: 6.0, gpusAvailable: 30 }),
      ]);
      await storage.insertGpuPriceSnapshots(new Date("2026-08-12T12:00:00.000Z"), [
        band("B200", { minUsd: 2.5, medianUsd: 7.0, p25Usd: 6.0, p75Usd: 8.0, gpusAvailable: 90 }),
      ]);
      await storage.insertGpuPriceSnapshots(new Date("2026-08-12T23:45:00.000Z"), [
        band("B200", { minUsd: 3.0, medianUsd: 6.0, p25Usd: 5.0, p75Usd: 7.0, gpusAvailable: 50 }),
      ]);
      await storage.insertGpuPriceSnapshots(new Date("2026-08-13T00:15:00.000Z"), [
        band("B200", { minUsd: 3.2, medianUsd: 6.5 }),
        band("B300", { minUsd: 7.0, medianUsd: 7.5 }),
      ]);

      const daily = await storage.getGpuDaily({});
      expect(daily.map((d) => `${d.gpuName}:${d.date}`)).toEqual([
        "B200:2026-08-12",
        "B200:2026-08-13",
        "B300:2026-08-13",
      ]);

      const day1 = daily[0]!;
      expect(day1.samples).toBe(3);
      expect(day1.minUsd).toBeCloseTo(2.5, 9); // best price reachable that day
      expect(day1.medianUsd).toBeCloseTo(6.0, 9); // median of sweep medians
      expect(day1.p25Usd).toBeCloseTo(5.0, 9);
      expect(day1.p75Usd).toBeCloseTo(7.0, 9);
      expect(day1.gpusAvailable).toBe(90); // peak depth

      const filtered = await storage.getGpuDaily({ gpuName: "B300" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.date).toBe("2026-08-13");

      const recent = await storage.getGpuDaily({ since: "2026-08-13T00:00:00.000Z" });
      expect(recent.map((d) => d.gpuName)).toEqual(["B200", "B300"]);
    } finally {
      await cleanup();
    }
  });

  it("daily aggregation ignores null bands without zeroing the day", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      await storage.insertGpuPriceSnapshots(new Date("2026-08-12T01:00:00.000Z"), [
        band("B200", { minUsd: null, medianUsd: null, p25Usd: null, p75Usd: null, offers: 0 }),
      ]);
      await storage.insertGpuPriceSnapshots(new Date("2026-08-12T02:00:00.000Z"), [
        band("B200", { minUsd: 3.0, medianUsd: 5.0 }),
      ]);
      const daily = await storage.getGpuDaily({ gpuName: "B200" });
      expect(daily).toHaveLength(1);
      expect(daily[0]!.minUsd).toBeCloseTo(3.0, 9);
      expect(daily[0]!.medianUsd).toBeCloseTo(5.0, 9);
      expect(daily[0]!.samples).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("writing an empty batch is a no-op, not a malformed statement", async () => {
    const { storage, cleanup } = await createIsolatedStorage();
    try {
      expect(await storage.insertGpuPriceSnapshots(new Date(), [])).toBe(0);
      expect(await storage.getGpuSeries({})).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});
