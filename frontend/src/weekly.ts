// Daily market series → Monday-to-Sunday weekly totals. Daily spend is noisy
// (weekend dips, ingest gaps); weekly bars are what a trend actually looks like.

import type { UsageSeriesPoint } from "./api";

export interface WeekBucket {
  /** Monday of the week, YYYY-MM-DD. */
  weekStart: string;
  /** Sunday of the week, YYYY-MM-DD. */
  weekEnd: string;
  spendUsd: number;
  tokens: number;
  /** Days of data present — a partial week is priced lower for a boring reason. */
  days: number;
  complete: boolean;
}

const DAY_MS = 86_400_000;

function toUtc(date: string): number {
  return Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Monday of the week containing `date` (ISO weeks start Monday). */
export function weekStartOf(date: string): string {
  const ms = toUtc(date);
  if (!Number.isFinite(ms)) return date.slice(0, 10);
  const dow = new Date(ms).getUTCDay(); // 0 = Sunday
  return iso(ms - ((dow + 6) % 7) * DAY_MS);
}

/** Sum a daily series into Mon–Sun buckets, oldest first. */
export function toWeeklyBuckets(series: UsageSeriesPoint[]): WeekBucket[] {
  const byWeek = new Map<string, WeekBucket>();
  for (const point of series) {
    if (!point.bucketDate) continue;
    const weekStart = weekStartOf(point.bucketDate);
    let bucket = byWeek.get(weekStart);
    if (!bucket) {
      bucket = {
        weekStart,
        weekEnd: iso(toUtc(weekStart) + 6 * DAY_MS),
        spendUsd: 0,
        tokens: 0,
        days: 0,
        complete: false,
      };
      byWeek.set(weekStart, bucket);
    }
    bucket.spendUsd += point.totalSpendUsd ?? 0;
    bucket.tokens += point.totalTokens ?? 0;
    bucket.days += 1;
    bucket.complete = bucket.days >= 7;
  }
  return [...byWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/**
 * Drop leading part-weeks. The oldest bucket is only short because coverage
 * starts mid-week, and a stub bar reads as a collapse that never happened.
 * A trailing part-week is kept — that one is the week in progress.
 */
export function trimLeadingPartial(weeks: WeekBucket[]): WeekBucket[] {
  const first = weeks.findIndex((w) => w.complete);
  return first <= 0 ? weeks.slice(Math.max(first, 0)) : weeks.slice(first);
}

export type WeekMetric = "spend" | "tokens";

export interface WeekForecast {
  weekStart: string;
  /** Booked so far. */
  observed: number;
  /** Full-week estimate: observed ÷ share of a typical week the days cover. */
  projected: number;
  /** Share of a normal week the booked days represent (0–1). */
  covered: number;
  daysCovered: number;
  /** Complete weeks the weekday profile was learned from. */
  basisWeeks: number;
  /** Weekend day average ÷ weekday average, from that profile. */
  weekendRatio: number | null;
  /** True when the newest day is today and was counted pro-rata to the hour. */
  partialToday: boolean;
}

const MIN_COVERED = 0.12;
const PROFILE_WEEKS = 8;

function valueOf(point: UsageSeriesPoint, metric: WeekMetric): number {
  return (metric === "spend" ? point.totalSpendUsd : point.totalTokens) ?? 0;
}

/**
 * Average share of a week's total that each weekday carries (index 0 = Monday),
 * learned from the most recent complete weeks. Traffic is markedly lighter on
 * weekends, so a flat days/7 projection over-counts a Mon–Wed stub.
 */
export function weekdayProfile(series: UsageSeriesPoint[], metric: WeekMetric, limit = PROFILE_WEEKS): number[] {
  const byWeek = new Map<string, number[]>();
  for (const point of series) {
    if (!point.bucketDate) continue;
    const start = weekStartOf(point.bucketDate);
    const days = byWeek.get(start) ?? new Array(7).fill(0);
    const dow = (new Date(toUtc(point.bucketDate)).getUTCDay() + 6) % 7;
    days[dow] += valueOf(point, metric);
    byWeek.set(start, days);
  }
  const complete = [...byWeek.entries()]
    .filter(([, days]) => days.every((v) => v > 0))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-limit)
    .map(([, days]) => days);

  if (!complete.length) return new Array(7).fill(1 / 7);
  const shares = new Array(7).fill(0);
  for (const days of complete) {
    const total = days.reduce((a, b) => a + b, 0);
    if (total <= 0) continue;
    for (let i = 0; i < 7; i++) shares[i] += days[i] / total;
  }
  const sum = shares.reduce((a, b) => a + b, 0);
  return sum > 0 ? shares.map((s) => s / sum) : new Array(7).fill(1 / 7);
}

/**
 * Project the week in progress to a full-week total. Each booked day is credited
 * with the share of a normal week its weekday usually carries; the newest day is
 * credited pro-rata to the hour if it is still running. Returns null when the
 * week is already complete or too little of it is booked to say anything.
 */
export function forecastCurrentWeek(
  series: UsageSeriesPoint[],
  metric: WeekMetric,
  nowMs: number,
): WeekForecast | null {
  const weeks = toWeeklyBuckets(series);
  const current = weeks[weeks.length - 1];
  if (!current || current.complete) return null;

  const profile = weekdayProfile(series, metric);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const hourFraction = Math.min(1, Math.max(0, (nowMs - toUtc(today)) / DAY_MS));

  const days = series.filter((p) => p.bucketDate && weekStartOf(p.bucketDate) === current.weekStart);
  let covered = 0;
  let observed = 0;
  let partialToday = false;
  for (const point of days) {
    const dow = (new Date(toUtc(point.bucketDate)).getUTCDay() + 6) % 7;
    const isToday = point.bucketDate.slice(0, 10) === today;
    if (isToday) partialToday = true;
    covered += (profile[dow] ?? 1 / 7) * (isToday ? hourFraction : 1);
    observed += valueOf(point, metric);
  }
  if (covered < MIN_COVERED) return null;

  const weekdayAvg = (profile[0]! + profile[1]! + profile[2]! + profile[3]! + profile[4]!) / 5;
  const weekendAvg = (profile[5]! + profile[6]!) / 2;
  return {
    weekStart: current.weekStart,
    observed,
    projected: observed / covered,
    covered,
    daysCovered: days.length,
    basisWeeks: Math.min(PROFILE_WEEKS, weeks.filter((w) => w.complete).length),
    weekendRatio: weekdayAvg > 0 ? weekendAvg / weekdayAvg : null,
    partialToday,
  };
}
