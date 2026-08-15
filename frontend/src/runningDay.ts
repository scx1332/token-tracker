// One rule about the day that has not ended yet, in one place.
//
// Every daily series on this site is a **sum** — tokens, dollars, requests — so
// its newest bucket is always short, for the boring reason that the day is
// still running. That value is real data, not a dip, and it is shown: dropping
// it left the tape silent about the only day anyone is actually asking about.
// But it is never averaged into a rate, never compared against whole days, and
// never scaled up to guess where it will land. This portal projects **weeks**,
// not days — a single day swings ~20% on which weekday it is before anything
// interesting has happened, so a day-level forecast is noise wearing a number.
//
// So: shown, marked, and excluded from every statistic. Charts call
// `isClosedDay` to decide what to shade; anything that averages, totals or
// compares calls `closedOnly` first.
//
// GPU price bands are the exception that proves the rule, and are left alone:
// a day's min/median/p25/p75 are medians *of that day's sweeps*, not sums, so a
// half-finished day already carries a perfectly good number.

/** The UTC day still filling. Every earlier day has ended. */
export function runningDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * True when this bucket date is a day that has ended, in UTC — which is the
 * timezone every bucket_date in the database is keyed by, so the comparison is
 * a string compare against today and needs no clock arithmetic.
 */
export function isClosedDay(date: string, nowMs: number): boolean {
  return date.slice(0, 10) < runningDay(nowMs);
}

/** Drop the day in progress. Use before averaging, totalling or comparing. */
export function closedOnly<T>(rows: T[], dateOf: (row: T) => string, nowMs: number): T[] {
  return rows.filter((row) => isClosedDay(dateOf(row), nowMs));
}
