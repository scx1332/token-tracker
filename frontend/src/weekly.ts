// Daily market series → Monday-to-Sunday weekly totals. Daily spend is noisy
// (weekend dips, ingest gaps); weekly bars are what a trend actually looks like.

import type { UsageSeriesPoint } from "./api";
import { isClosedDay } from "./runningDay";

export interface WeekDayCell {
  /** YYYY-MM-DD. */
  date: string;
  spendUsd: number;
  tokens: number;
}

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
  /** Per-weekday breakdown, index 0 = Monday; null = no data for that day. */
  byDay: (WeekDayCell | null)[];
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
        byDay: new Array(7).fill(null),
      };
      byWeek.set(weekStart, bucket);
    }
    bucket.spendUsd += point.totalSpendUsd ?? 0;
    bucket.tokens += point.totalTokens ?? 0;
    const dow = (new Date(toUtc(point.bucketDate)).getUTCDay() + 6) % 7;
    const cell = bucket.byDay[dow] ?? { date: point.bucketDate.slice(0, 10), spendUsd: 0, tokens: 0 };
    cell.spendUsd += point.totalSpendUsd ?? 0;
    cell.tokens += point.totalTokens ?? 0;
    bucket.byDay[dow] = cell;
    // Days = distinct weekdays seen, so a duplicate row can't fake a full week.
    bucket.days = bucket.byDay.reduce((n, c) => n + (c ? 1 : 0), 0);
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
  /** Booked over the week's **finished** days — the projection's whole basis. */
  observed: number;
  /** Full-week estimate: observed ÷ share of a typical week those days cover. */
  projected: number;
  /** Share of a normal week the finished days represent (0–1). */
  covered: number;
  daysCovered: number;
  /** Complete weeks the weekday profile was learned from. */
  basisWeeks: number;
  /** Weekend day average ÷ weekday average, from that profile. */
  weekendRatio: number | null;
  /**
   * The day in progress, if this week has one. It is shown on the bar because
   * it is real, and left out of everything above because it is not a day yet.
   */
  runningDayValue: number | null;
}

const MIN_COVERED = 0.12;
const PROFILE_WEEKS = 8;
/**
 * Per-week recency decay when averaging weekday shares: the newest complete
 * week counts 1, the one before 0.6, then 0.36… The weekly shape drifts — the
 * weekend dip that was ~30% in June had all but vanished by mid-August, and a
 * flat 8-week average carried the June shape long enough to read a week that
 * was pacing +17% on same-weekday spend as −2% w/w. Half-life ≈ 1.4 weeks
 * tracks that drift; backtesting Mon–Sat cut points over the full series, it
 * matches the flat average on error and beats it whenever the shape moves.
 */
const PROFILE_DECAY = 0.6;

function valueOf(point: UsageSeriesPoint, metric: WeekMetric): number {
  return (metric === "spend" ? point.totalSpendUsd : point.totalTokens) ?? 0;
}

/**
 * Share of a week's total that each weekday carries (index 0 = Monday), a
 * recency-weighted average over the most recent complete weeks. Weekends run
 * lighter than weekdays, so a flat days/7 projection over-counts a Mon–Wed
 * stub — and the size of that weekend dip itself moves month to month, which
 * is what the recency weighting (PROFILE_DECAY) is for.
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
  complete.forEach((days, index) => {
    const total = days.reduce((a, b) => a + b, 0);
    if (total <= 0) return;
    const weight = PROFILE_DECAY ** (complete.length - 1 - index);
    for (let i = 0; i < 7; i++) shares[i] += weight * (days[i] / total);
  });
  const sum = shares.reduce((a, b) => a + b, 0);
  return sum > 0 ? shares.map((s) => s / sum) : new Array(7).fill(1 / 7);
}

/**
 * Project the week in progress to a full-week total. Each **finished** day is
 * credited with the share of a normal week its weekday usually carries.
 *
 * The day still running is excluded outright — it is the one number on the page
 * we deliberately do not extrapolate. This used to credit it pro-rata to the
 * hour, which sounds reasonable and is not: the model-level series does not
 * accumulate through the day at all (OpenRouter publishes a day once it has
 * ended), so a value sitting on today is a *coverage* artifact of the repair
 * path — 6.22T across 203 models against the ~11T across ~500 the day became —
 * and dividing that by the elapsed hours produced a confident wrong answer that
 * moved every time it was looked at. Weeks are the unit this portal forecasts.
 *
 * Returns null when the week is complete, or when too little of it has finished
 * to say anything — including a brand-new week whose only day is today.
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
  const days = series.filter((p) => p.bucketDate && weekStartOf(p.bucketDate) === current.weekStart);
  let covered = 0;
  let observed = 0;
  let daysCovered = 0;
  let runningDayValue: number | null = null;
  for (const point of days) {
    if (!isClosedDay(point.bucketDate, nowMs)) {
      runningDayValue = (runningDayValue ?? 0) + valueOf(point, metric);
      continue;
    }
    const dow = (new Date(toUtc(point.bucketDate)).getUTCDay() + 6) % 7;
    covered += profile[dow] ?? 1 / 7;
    observed += valueOf(point, metric);
    daysCovered += 1;
  }
  if (covered < MIN_COVERED) return null;

  const weekdayAvg = (profile[0]! + profile[1]! + profile[2]! + profile[3]! + profile[4]!) / 5;
  const weekendAvg = (profile[5]! + profile[6]!) / 2;
  return {
    weekStart: current.weekStart,
    observed,
    projected: observed / covered,
    covered,
    daysCovered,
    basisWeeks: Math.min(PROFILE_WEEKS, weeks.filter((w) => w.complete).length),
    weekendRatio: weekdayAvg > 0 ? weekendAvg / weekdayAvg : null,
    runningDayValue,
  };
}
