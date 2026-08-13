// Pure helpers for the GPU rental series: collapsing the hourly offer-book
// snapshots to daily points, and putting compute prices on the same axis as
// token prices.
//
// The comparison this file exists for is trend, not level. Raw accelerator
// rental is quoted in $/GPU-hour and inference in $/Mtok; the ratio between
// them depends on model size, batch efficiency and quantization, none of which
// we observe. What IS comparable is *direction and pace*: rebasing both series
// to 100 at the start of the window answers "has inference cheapened faster
// than the silicon under it?" without pretending to a conversion we can't make.

import type { GpuPriceRow, PriceIndexPoint } from "./api";

export interface GpuDailyPoint {
  date: string;
  /** Cheapest rentable offer seen that day, USD/GPU-hour. */
  minUsd: number | null;
  /** Median of the hourly medians — the day's typical price. */
  medianUsd: number | null;
  p25Usd: number | null;
  p75Usd: number | null;
  /** Peak GPU depth observed that day. */
  gpusAvailable: number;
  /** Hourly snapshots that contributed. */
  samples: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function defined(values: (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null && Number.isFinite(v));
}

/** UTC calendar day of an ISO timestamp. */
export function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Collapse hourly snapshots for ONE GPU into one point per UTC day.
 *
 * The day's `minUsd` is the true minimum across the day (the best price that
 * was actually rentable at some point), while `medianUsd` is the median of the
 * hourly medians rather than a median over pooled offers — hours with a deeper
 * book must not outvote thin ones when describing a typical day.
 */
export function toDailyPoints(rows: GpuPriceRow[]): GpuDailyPoint[] {
  const byDay = new Map<string, GpuPriceRow[]>();
  for (const row of rows) {
    const day = utcDay(row.capturedAt);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(row);
    else byDay.set(day, [row]);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, dayRows]) => {
      const mins = defined(dayRows.map((r) => r.minUsd));
      return {
        date,
        minUsd: mins.length ? Math.min(...mins) : null,
        medianUsd: median(defined(dayRows.map((r) => r.medianUsd))),
        p25Usd: median(defined(dayRows.map((r) => r.p25Usd))),
        p75Usd: median(defined(dayRows.map((r) => r.p75Usd))),
        gpusAvailable: dayRows.reduce((max, r) => Math.max(max, r.gpusAvailable), 0),
        samples: dayRows.length,
      };
    });
}

/** Split a multi-GPU series into one sorted series per GPU name. */
export function groupByGpu(rows: GpuPriceRow[]): Map<string, GpuPriceRow[]> {
  const byGpu = new Map<string, GpuPriceRow[]>();
  for (const row of rows) {
    const bucket = byGpu.get(row.gpuName);
    if (bucket) bucket.push(row);
    else byGpu.set(row.gpuName, [row]);
  }
  for (const series of byGpu.values()) {
    series.sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0));
  }
  return byGpu;
}

/**
 * Rebase a series to 100 at its first usable value, so series in different
 * units can share one axis.
 *
 * Zero is treated as missing, not as a price: neither a $0/GPU-hour rental nor
 * a $0/Mtok weighted index is a real quote, and plotting one would draw a cliff
 * to the axis (or divide by it). So zeros and nulls alike come back null, and
 * the base is the first strictly positive value.
 */
export function rebase(values: (number | null)[]): (number | null)[] {
  const usable = (v: number | null): v is number => v !== null && Number.isFinite(v) && v > 0;
  const base = values.find(usable);
  if (base === undefined) return values.map(() => null);
  return values.map((v) => (usable(v) ? (v / base) * 100 : null));
}

export interface ComparisonSeries {
  dates: string[];
  /** Token price index (usage-weighted $/Mtok), rebased to 100. */
  tokenIndex: (number | null)[];
  /** GPU rental price, rebased to 100 over the same dates. */
  gpuIndex: (number | null)[];
  /** Raw values kept for the tooltip, in their original units. */
  tokenRaw: (number | null)[];
  gpuRaw: (number | null)[];
}

/**
 * Align the token price index and one GPU's daily price onto a shared date
 * axis, both rebased to 100.
 *
 * The axis is the intersection of the two date sets: the GPU series only starts
 * when we began polling vast.ai, and showing a flat-null stub stretching back
 * across months of token history would misread as "GPU prices were unchanged".
 */
export function buildComparison(
  priceIndex: PriceIndexPoint[],
  gpuDaily: GpuDailyPoint[],
  gpuMetric: "minUsd" | "medianUsd" = "medianUsd",
): ComparisonSeries {
  const gpuByDate = new Map(gpuDaily.map((p) => [p.date, p]));
  const tokenByDate = new Map(priceIndex.map((p) => [p.date, p]));

  const dates = priceIndex
    .map((p) => p.date)
    .filter((date) => gpuByDate.has(date))
    .sort();

  const tokenRaw = dates.map((d) => tokenByDate.get(d)?.weightedUsdPerMtok ?? null);
  const gpuRaw = dates.map((d) => gpuByDate.get(d)?.[gpuMetric] ?? null);

  return {
    dates,
    tokenIndex: rebase(tokenRaw),
    gpuIndex: rebase(gpuRaw),
    tokenRaw,
    gpuRaw,
  };
}

/** Percent change between the first and last usable values, or null. */
export function totalChangePct(values: (number | null)[]): number | null {
  const usable = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (usable.length < 2) return null;
  const first = usable[0]!;
  const last = usable[usable.length - 1]!;
  if (first === 0) return null;
  return ((last - first) / first) * 100;
}
