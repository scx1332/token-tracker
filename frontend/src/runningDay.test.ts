import { describe, expect, it } from "bun:test";
import { closedOnly, isClosedDay, runningDay } from "./runningDay";

const NOON = Date.parse("2026-08-15T12:00:00Z");

describe("runningDay", () => {
  it("is today in UTC, whatever the hour", () => {
    expect(runningDay(Date.parse("2026-08-15T00:00:01Z"))).toBe("2026-08-15");
    expect(runningDay(NOON)).toBe("2026-08-15");
    expect(runningDay(Date.parse("2026-08-15T23:59:59Z"))).toBe("2026-08-15");
  });

  it("rolls at UTC midnight, not at the viewer's midnight", () => {
    // 01:30 in Berlin on the 16th is still the 15th in UTC, and bucket dates
    // are UTC — reading them in local time would shade the wrong bar.
    expect(runningDay(Date.parse("2026-08-15T23:30:00Z"))).toBe("2026-08-15");
    expect(runningDay(Date.parse("2026-08-16T00:30:00Z"))).toBe("2026-08-16");
  });
});

describe("isClosedDay", () => {
  it("closes a day only once it has ended", () => {
    expect(isClosedDay("2026-08-14", NOON)).toBe(true);
    expect(isClosedDay("2026-08-15", NOON)).toBe(false);
  });

  it("treats a timestamp like the day it falls in", () => {
    expect(isClosedDay("2026-08-14T23:00:00Z", NOON)).toBe(true);
    expect(isClosedDay("2026-08-15T00:00:00Z", NOON)).toBe(false);
  });

  it("does not close a future day either", () => {
    expect(isClosedDay("2026-08-16", NOON)).toBe(false);
  });
});

describe("closedOnly", () => {
  const series = [
    { bucketDate: "2026-08-13", v: 1 },
    { bucketDate: "2026-08-14", v: 2 },
    { bucketDate: "2026-08-15", v: 3 },
  ];

  it("drops the day in progress and keeps the rest in order", () => {
    expect(closedOnly(series, (r) => r.bucketDate, NOON).map((r) => r.v)).toEqual([1, 2]);
  });

  it("is a no-op on a series that ends on a closed day", () => {
    // The usual case: rankings publishes a day once it has ended, so the
    // model-level series normally stops at yesterday all by itself.
    expect(closedOnly(series.slice(0, 2), (r) => r.bucketDate, NOON)).toHaveLength(2);
  });

  it("can empty a series, and says so rather than inventing a day", () => {
    expect(closedOnly([{ bucketDate: "2026-08-15", v: 3 }], (r) => r.bucketDate, NOON)).toEqual([]);
  });
});
