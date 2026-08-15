import { describe, expect, it } from "bun:test";
import { forecastCurrentWeek, toWeeklyBuckets, trimLeadingPartial, weekStartOf, weekdayProfile } from "./weekly";
import type { UsageSeriesPoint } from "./api";

function day(date: string, spend: number, tokens: number): UsageSeriesPoint {
  return { bucketDate: date, totalSpendUsd: spend, totalTokens: tokens, modelCount: 1 };
}

describe("weekStartOf", () => {
  it("snaps every weekday back to its Monday", () => {
    // 2026-08-10 is a Monday.
    expect(weekStartOf("2026-08-10")).toBe("2026-08-10");
    expect(weekStartOf("2026-08-13")).toBe("2026-08-10");
    expect(weekStartOf("2026-08-16")).toBe("2026-08-10"); // Sunday belongs to the same week
    expect(weekStartOf("2026-08-17")).toBe("2026-08-17");
  });

  it("accepts full timestamps", () => {
    expect(weekStartOf("2026-08-13T11:22:33.000Z")).toBe("2026-08-10");
  });
});

describe("toWeeklyBuckets", () => {
  it("sums Mon–Sun and flags complete weeks", () => {
    const series = [
      day("2026-08-03", 10, 100),
      day("2026-08-04", 10, 100),
      day("2026-08-05", 10, 100),
      day("2026-08-06", 10, 100),
      day("2026-08-07", 10, 100),
      day("2026-08-08", 10, 100),
      day("2026-08-09", 10, 100),
      day("2026-08-10", 5, 50),
      day("2026-08-11", 5, 50),
    ];
    const weeks = toWeeklyBuckets(series);
    expect(weeks).toHaveLength(2);
    expect(weeks[0]).toMatchObject({
      weekStart: "2026-08-03",
      weekEnd: "2026-08-09",
      spendUsd: 70,
      tokens: 700,
      days: 7,
      complete: true,
    });
    expect(weeks[1]).toMatchObject({ weekStart: "2026-08-10", spendUsd: 10, days: 2, complete: false });
  });

  it("treats missing values as zero and sorts oldest first", () => {
    const weeks = toWeeklyBuckets([
      { bucketDate: "2026-08-11", totalSpendUsd: null, totalTokens: 5, modelCount: 0 },
      day("2026-08-04", 3, 1),
    ]);
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-08-03", "2026-08-10"]);
    expect(weeks[1]?.spendUsd).toBe(0);
    expect(weeks[1]?.tokens).toBe(5);
  });

  it("drops a leading part-week but keeps the running one", () => {
    const weeks = toWeeklyBuckets([
      day("2026-08-01", 1, 1), // Saturday — stub of the week starting Jul 27
      ...[3, 4, 5, 6, 7, 8, 9].map((d) => day(`2026-08-0${d}`, 10, 10)),
      day("2026-08-10", 10, 10),
    ]);
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-07-27", "2026-08-03", "2026-08-10"]);
    expect(trimLeadingPartial(weeks).map((w) => w.weekStart)).toEqual(["2026-08-03", "2026-08-10"]);
  });

  it("ignores rows without a date", () => {
    expect(toWeeklyBuckets([{ bucketDate: "", totalSpendUsd: 1, totalTokens: 1, modelCount: 1 }])).toEqual([]);
  });

  it("keeps the per-day breakdown, Monday-indexed with nulls for gaps", () => {
    const weeks = toWeeklyBuckets([
      day("2026-08-04", 3, 30), // Tuesday
      day("2026-08-09", 7, 70), // Sunday
    ]);
    const byDay = weeks[0]!.byDay;
    expect(byDay).toHaveLength(7);
    expect(byDay[0]).toBeNull();
    expect(byDay[1]).toEqual({ date: "2026-08-04", spendUsd: 3, tokens: 30 });
    expect(byDay[6]).toEqual({ date: "2026-08-09", spendUsd: 7, tokens: 70 });
  });

  it("merges duplicate rows for one date without double-counting the day", () => {
    const weeks = toWeeklyBuckets([day("2026-08-04", 3, 30), day("2026-08-04T12:00:00Z", 2, 20)]);
    expect(weeks[0]).toMatchObject({ days: 1, spendUsd: 5, complete: false });
    expect(weeks[0]!.byDay[1]).toEqual({ date: "2026-08-04", spendUsd: 5, tokens: 50 });
  });
});

// Four identical weeks: 10/day Mon–Fri, 5/day Sat–Sun (week total 60).
function shapedSeries(weekStarts: string[], daysPerWeek = 7): UsageSeriesPoint[] {
  const out: UsageSeriesPoint[] = [];
  for (const start of weekStarts) {
    const base = Date.parse(`${start}T00:00:00Z`);
    for (let i = 0; i < daysPerWeek; i++) {
      const date = new Date(base + i * 86_400_000).toISOString().slice(0, 10);
      const v = i < 5 ? 10 : 5;
      out.push(day(date, v, v * 100));
    }
  }
  return out;
}

describe("weekdayProfile", () => {
  it("learns the weekend dip", () => {
    const profile = weekdayProfile(shapedSeries(["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"]), "spend");
    expect(profile).toHaveLength(7);
    expect(profile[0]).toBeCloseTo(10 / 60, 6);
    expect(profile[5]).toBeCloseTo(5 / 60, 6);
    expect(profile.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it("falls back to a flat week without complete history", () => {
    expect(weekdayProfile([day("2026-08-10", 1, 1)], "spend")[3]).toBeCloseTo(1 / 7, 6);
  });
});

describe("forecastCurrentWeek", () => {
  const history = shapedSeries(["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"]);

  it("projects a Mon–Wed stub to the full week using the weekday profile", () => {
    const series = [...history, ...shapedSeries(["2026-08-03"], 3)]; // Mon–Wed = 30
    const f = forecastCurrentWeek(series, "spend", Date.parse("2026-08-06T12:00:00Z"));
    expect(f).not.toBeNull();
    expect(f!.weekStart).toBe("2026-08-03");
    expect(f!.observed).toBe(30);
    expect(f!.covered).toBeCloseTo(0.5, 6); // 3 weekdays × 10/60
    expect(f!.projected).toBeCloseTo(60, 6); // not 30/3×7 = 70
    expect(f!.runningDayValue).toBeNull();
    expect(f!.weekendRatio).toBeCloseTo(0.5, 6);
  });

  // The day in progress is reported so the bar and the note can show it, and
  // kept out of the projection entirely: this portal forecasts weeks, not days.
  it("reports a still-running day without projecting from it", () => {
    const series = [...history, ...shapedSeries(["2026-08-03"], 3), day("2026-08-06", 5, 500)];
    const f = forecastCurrentWeek(series, "spend", Date.parse("2026-08-06T12:00:00Z"));
    expect(f!.runningDayValue).toBe(5);
    // Unchanged from the same week without today's partial row in it.
    expect(f!.daysCovered).toBe(3);
    expect(f!.observed).toBe(30);
    expect(f!.covered).toBeCloseTo(0.5, 6);
    expect(f!.projected).toBeCloseTo(60, 6);
  });

  it("does not scale a half-finished day up, however big it looks", () => {
    // Thursday lands at 9 of a normal 10 by mid-morning — a real possibility on
    // a busy day, and pro-rata credit turned it into a 3× week.
    const series = [...history, ...shapedSeries(["2026-08-03"], 3), day("2026-08-06", 9, 900)];
    const f = forecastCurrentWeek(series, "spend", Date.parse("2026-08-06T04:00:00Z"));
    expect(f!.projected).toBeCloseTo(60, 6);
  });

  it("returns null for a complete week and for a too-thin one", () => {
    expect(forecastCurrentWeek(history, "spend", Date.parse("2026-08-03T09:00:00Z"))).toBeNull();
    const thin = [...history, day("2026-08-03T00:00:00Z", 1, 1)];
    const f = forecastCurrentWeek(thin, "spend", Date.parse("2026-08-03T01:00:00Z"));
    expect(f).toBeNull(); // only a sliver of Monday booked
  });

  it("returns null for a week whose only day is still running", () => {
    // Monday, mid-morning. There is nothing finished to project from, so the
    // honest answer is no projection rather than a number built from one hour.
    const series = [...history, day("2026-08-03", 4, 400)];
    expect(forecastCurrentWeek(series, "spend", Date.parse("2026-08-03T09:00:00Z"))).toBeNull();
  });
});
