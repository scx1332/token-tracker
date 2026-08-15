// Pure helpers for the GPU rental series: putting compute prices on the same
// axis as token prices, and folding sub-hourly sweeps into hour-of-day
// profiles.
//
// Daily collapsing lives on the server now (`/gpu/daily`) — with a 15-minute
// sweep cadence the raw all-GPU series is far too heavy to ship to the browser
// just to be averaged there. What stays here is what is genuinely
// presentational: rebasing, alignment, seasonality.
//
// The comparison this file exists for is trend, not level. Raw accelerator
// rental is quoted in $/GPU-hour and inference in $/Mtok; the ratio between
// them depends on model size, batch efficiency and quantization, none of which
// we observe. What IS comparable is *direction and pace*: rebasing both series
// to 100 at the start of the window answers "has inference cheapened faster
// than the silicon under it?" without pretending to a conversion we can't make.

import type { GpuDailyRow, PriceIndexPoint } from "./api";

/** The date+band shape buildComparison needs — server daily rows satisfy it. */
export interface DailyBandPoint {
  date: string;
  minUsd: number | null;
  medianUsd: number | null;
}

/** Split the all-GPU daily rollup into one date-sorted series per GPU. */
export function groupDailyByGpu(rows: GpuDailyRow[]): Map<string, GpuDailyRow[]> {
  const byGpu = new Map<string, GpuDailyRow[]>();
  for (const row of rows) {
    const bucket = byGpu.get(row.gpuName);
    if (bucket) bucket.push(row);
    else byGpu.set(row.gpuName, [row]);
  }
  for (const series of byGpu.values()) {
    series.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  return byGpu;
}

/** Rows whose timestamp falls inside the trailing `hours`-hour window. */
export function lastWindow<T extends { capturedAt: string }>(
  rows: T[],
  hours: number,
  nowMs: number,
): T[] {
  const cutoff = nowMs - hours * 3_600_000;
  return rows.filter((row) => {
    const t = Date.parse(row.capturedAt);
    return Number.isFinite(t) && t >= cutoff;
  });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface HourProfilePoint {
  /** UTC hour, 0-23. */
  hour: number;
  /** Median of the metric across every sample that landed in this hour. */
  median: number | null;
  /** median / (median of the hourly medians) × 100 — the seasonality index. */
  index: number | null;
  /** Samples that contributed. */
  samples: number;
}

/**
 * Fold a timestamped series into a 24-point UTC hour-of-day profile.
 *
 * Per-hour medians (robust to the odd spike) are normalized by the median of
 * the hourly medians, so every hour weighs equally in the baseline no matter
 * how unevenly sweeps are distributed — a series that only started yesterday
 * afternoon must not make 14:00 look like "the average hour". The index reads
 * as "percent of a typical hour": 95 at 04:00 means 4 AM UTC runs 5% cheap.
 *
 * Zero is a legal value here (a GPU's depth can genuinely be zero at 3 AM), so
 * unlike `rebase` this does its own normalization and only returns null indexes
 * when the baseline itself is missing or zero.
 */
export function hourOfDayProfile(
  points: { at: string; value: number | null }[],
): HourProfilePoint[] {
  const byHour: number[][] = Array.from({ length: 24 }, () => []);
  for (const point of points) {
    if (point.value === null || !Number.isFinite(point.value)) continue;
    const t = new Date(point.at);
    if (Number.isNaN(t.getTime())) continue;
    byHour[t.getUTCHours()]!.push(point.value);
  }

  const medians = byHour.map((values) => median(values));
  const baseline = median(medians.filter((v): v is number => v !== null));

  return medians.map((value, hour) => ({
    hour,
    median: value,
    index:
      value === null || baseline === null || baseline === 0
        ? null
        : (value / baseline) * 100,
    samples: byHour[hour]!.length,
  }));
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
  gpuDaily: DailyBandPoint[],
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

/**
 * Hourly version of `buildComparison`, for young GPU histories.
 *
 * With only a few days of vast.ai data, the daily comparison is two or three
 * points — a slope chart with no slope to read. But both sides exist at finer
 * grain: token snapshots land hourly and GPU sweeps every 15 minutes. Bucket
 * each to the UTC hour (median within the hour — a sweep median over 4 samples,
 * usually a single token snapshot) and align on hours where both exist. Same
 * contract as the daily build: dates are ISO hour stamps, both series rebased
 * to 100 at the shared start.
 */
export function buildHourlyComparison(
  snapshots: { capturedAt: string; usageWeightedPromptUsdPerMtok: number | null }[],
  sweeps: { capturedAt: string; minUsd: number | null; medianUsd: number | null }[],
  gpuMetric: "minUsd" | "medianUsd" = "medianUsd",
): ComparisonSeries {
  const hourKey = (at: string): string | null => {
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return null;
    return new Date(Math.floor(t / 3_600_000) * 3_600_000).toISOString().slice(0, 16);
  };

  const bucket = (points: { at: string; value: number | null }[]): Map<string, number> => {
    const byHour = new Map<string, number[]>();
    for (const p of points) {
      if (p.value === null || !Number.isFinite(p.value)) continue;
      const key = hourKey(p.at);
      if (key === null) continue;
      const list = byHour.get(key);
      if (list) list.push(p.value);
      else byHour.set(key, [p.value]);
    }
    const out = new Map<string, number>();
    for (const [key, values] of byHour) {
      const m = median(values);
      if (m !== null) out.set(key, m);
    }
    return out;
  };

  const tokenByHour = bucket(
    snapshots.map((s) => ({ at: s.capturedAt, value: s.usageWeightedPromptUsdPerMtok })),
  );
  const gpuByHour = bucket(sweeps.map((s) => ({ at: s.capturedAt, value: s[gpuMetric] })));

  const dates = [...tokenByHour.keys()].filter((h) => gpuByHour.has(h)).sort();
  const tokenRaw = dates.map((h) => tokenByHour.get(h) ?? null);
  const gpuRaw = dates.map((h) => gpuByHour.get(h) ?? null);

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
