import { describe, expect, it } from "bun:test";
import {
  evaluateChecks,
  lastClosedDay,
  overallStatus,
  USAGE_HISTORY_FLOOR,
  type Check,
  type MonitorFacts,
  type UsageDay,
} from "./monitor";

// The alarm's own tests. Every case below is a production failure the checks
// exist to catch, written as the facts the database would actually report while
// it was happening — a dead scraper, a half-captured day, a double count, a
// hole in the history, a backup that stopped running. If one of these ever goes
// green, the corresponding outage is one nobody will be told about.

const NOW = "2026-08-15T18:00:00Z";

/** Minutes/hours before NOW, as the ISO string the facts carry. */
function ago(hours: number): string {
  return new Date(Date.parse(NOW) - hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A dense, healthy daily series. It ends on *yesterday*: `rankings?view=day`
 * publishes one date, the day that has ended, and flips within an hour of UTC
 * midnight — so the current day is normally absent entirely.
 */
function healthyDaily(): UsageDay[] {
  const days: UsageDay[] = [];
  for (let i = 12; i >= 1; i -= 1) {
    const date = new Date(Date.parse("2026-08-15T00:00:00Z") - i * 86_400_000).toISOString().slice(0, 10);
    days.push({ date, tokens: 10_000_000_000_000, spendUsd: 3_500_000 });
  }
  return days;
}

/** …unless a mid-day `bun run backfill` planted a partial row for today. */
function withPartialToday(daily: UsageDay[]): UsageDay[] {
  return [...daily, { date: "2026-08-15", tokens: 5_600_000_000_000, spendUsd: 1_900_000 }];
}

/** A deployment where everything works, as the facts would read right now. */
function healthy(overrides: Partial<MonitorFacts> = {}): MonitorFacts {
  return {
    nowUtc: NOW,
    ingest: {
      lastStartedAt: ago(0.2),
      lastStatus: "ok",
      lastError: null,
      recentStatuses: ["ok", "ok", "ok", "ok", "ok"],
      lastOk: { startedAt: ago(0.2), modelsSeen: 413, usageRows: 509 },
    },
    latest: {
      catalog: ago(0.2),
      priceChange: ago(0.2),
      usageModel: ago(0.2),
      usageProvider: ago(3),
      effectivePrice: ago(3),
      providerVolume: ago(0.2),
      marketSnapshot: ago(0.2),
      gpuSweep: ago(0.1),
    },
    catalog: { total: 414, active: 413, activeMedian7d: 411 },
    usage: {
      firstDate: USAGE_HISTORY_FLOOR,
      lastDate: "2026-08-14",
      missingDates: [],
      daily: healthyDaily(),
    },
    gpu: { accelerators: 16, withOffers: 16 },
    backup: { name: "tokens-2026-08-15.sql.7z", ageHours: 16, bytes: 1_436_822 },
    ...overrides,
  };
}

function check(facts: MonitorFacts, name: string): Check {
  const found = evaluateChecks(facts).find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found;
}

describe("a working deployment", () => {
  it("passes every check", () => {
    const checks = evaluateChecks(healthy());
    const bad = checks.filter((c) => c.status !== "ok");
    expect(bad.map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
    expect(overallStatus(checks)).toBe("ok");
  });

  it("gives every check a stable name and a populated detail line", () => {
    const checks = evaluateChecks(healthy());
    expect(checks.length).toBeGreaterThan(10);
    expect(new Set(checks.map((c) => c.name)).size).toBe(checks.length);
    for (const c of checks) expect(c.detail.length).toBeGreaterThan(10);
  });
});

describe("the ingest loop stops", () => {
  it("warns after one missed pass and fails after three hours", () => {
    const facts = healthy();
    facts.ingest.lastStartedAt = ago(2.5);
    expect(check(facts, "ingest.pass").status).toBe("warn");
    facts.ingest.lastStartedAt = ago(4);
    expect(check(facts, "ingest.pass").status).toBe("fail");
  });

  it("fails when the container has never run a pass", () => {
    const facts = healthy();
    facts.ingest = { lastStartedAt: null, lastStatus: null, lastError: null, recentStatuses: [], lastOk: null };
    expect(check(facts, "ingest.pass").status).toBe("fail");
    expect(check(facts, "ingest.result").status).toBe("fail");
    expect(check(facts, "ingest.rows").status).toBe("fail");
  });
});

describe("passes that fail", () => {
  it("tolerates a single failure — OpenRouter rate-limits and the next pass refills", () => {
    const facts = healthy();
    facts.ingest.recentStatuses = ["ok", "error", "ok", "ok", "ok"];
    expect(check(facts, "ingest.result").status).toBe("warn");
  });

  it("fails on two in a row, and quotes the error", () => {
    const facts = healthy();
    facts.ingest.recentStatuses = ["error", "error", "ok", "ok", "ok"];
    facts.ingest.lastError = "openrouter 403: Cloudflare challenge";
    const result = check(facts, "ingest.result");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Cloudflare");
  });

  it("fails on a majority of recent failures even when they alternate", () => {
    const facts = healthy();
    facts.ingest.recentStatuses = ["ok", "error", "ok", "error", "error"];
    expect(check(facts, "ingest.result").status).toBe("fail");
  });
});

describe("a pass that succeeds but brings nothing home", () => {
  it("fails when the last good pass wrote no usage rows", () => {
    const facts = healthy();
    facts.ingest.lastOk = { startedAt: ago(0.2), modelsSeen: 413, usageRows: 0 };
    expect(check(facts, "ingest.rows").status).toBe("fail");
  });

  it("fails when the catalog came back empty", () => {
    const facts = healthy();
    facts.ingest.lastOk = { startedAt: ago(0.2), modelsSeen: 0, usageRows: 509 };
    expect(check(facts, "ingest.rows").status).toBe("fail");
  });
});

describe("one source stops while the rest keep going", () => {
  // The failure this whole file exists for: the process is up, the pass says
  // ok, and exactly one feed has gone quiet.
  const cases: [keyof MonitorFacts["latest"], string, number][] = [
    ["catalog", "catalog.scrape", 4],
    ["usageModel", "usage.rankings", 4],
    ["providerVolume", "providers.volume", 4],
    ["marketSnapshot", "market.snapshot", 4],
    ["usageProvider", "usage.providers", 60],
    ["effectivePrice", "prices.effective", 60],
    ["priceChange", "prices.changes", 30],
    ["gpuSweep", "gpu.sweep", 2],
  ];

  for (const [source, name, staleHours] of cases) {
    it(`fails ${name} when ${source} has not been written for ${staleHours}h`, () => {
      const facts = healthy();
      facts.latest[source] = ago(staleHours);
      expect(check(facts, name).status).toBe("fail");
      // ...and only that one. A broken vast.ai must not read as a broken market.
      const others = evaluateChecks(facts).filter((c) => c.name !== name && c.status !== "ok");
      expect(others).toEqual([]);
    });
  }

  it("fails a source that has never written anything", () => {
    const facts = healthy();
    facts.latest.gpuSweep = null;
    expect(check(facts, "gpu.sweep").detail).toContain("has ever been written");
    expect(check(facts, "gpu.sweep").status).toBe("fail");
  });

  it("lets prices stay quiet for a few hours — a change-log with no changes is legal", () => {
    const facts = healthy();
    facts.latest.priceChange = ago(4);
    expect(check(facts, "prices.changes").status).toBe("ok");
    facts.latest.priceChange = ago(8);
    expect(check(facts, "prices.changes").status).toBe("warn");
  });

  it("gives the daily sweep room for its 20-hour gate", () => {
    const facts = healthy();
    facts.latest.usageProvider = ago(22);
    expect(check(facts, "usage.providers").status).toBe("ok");
  });
});

describe("the usage series", () => {
  // The feed publishes a day once it has ended, so the newest bucket being
  // yesterday is the healthy state — a check that warned on it would warn
  // every day of its life and be muted within a week.
  it("accepts yesterday as the newest bucket, and today when a backfill planted one", () => {
    const facts = healthy();
    expect(check(facts, "usage.day").status).toBe("ok");
    facts.usage.lastDate = "2026-08-15";
    facts.usage.daily = withPartialToday(healthyDaily());
    expect(check(facts, "usage.day").status).toBe("ok");
  });

  it("warns at two days behind and fails at three", () => {
    const facts = healthy();
    facts.usage.lastDate = "2026-08-13";
    expect(check(facts, "usage.day").status).toBe("warn");
    facts.usage.lastDate = "2026-08-12";
    expect(check(facts, "usage.day").status).toBe("fail");
  });

  it("fails on a hole, and names the days that are missing", () => {
    const facts = healthy();
    facts.usage.missingDates = ["2026-08-09", "2026-08-10"];
    const gaps = check(facts, "usage.gaps");
    expect(gaps.status).toBe("fail");
    expect(gaps.detail).toContain("2026-08-09");
    expect(gaps.detail).toContain("2026-08-10");
  });

  it("fails when history loses its floor — those days cannot be re-fetched", () => {
    const facts = healthy();
    facts.usage.firstDate = "2026-06-01";
    const floor = check(facts, "usage.floor");
    expect(floor.status).toBe("fail");
    expect(floor.detail).toContain("14 day(s)");
  });

  it("only warns when history reaches back further than the floor", () => {
    const facts = healthy();
    facts.usage.firstDate = "2026-05-15";
    expect(check(facts, "usage.floor").status).toBe("warn");
  });
});

/** Rewrite whichever day the checks will judge, so the fixture shape can move. */
function setJudgedDay(facts: MonitorFacts, tokens: number | null, spendUsd: number | null): string {
  const judged = lastClosedDay(facts.usage.daily, "2026-08-15");
  if (!judged) throw new Error("no closed day to rewrite");
  const idx = facts.usage.daily.findIndex((d) => d.date === judged.day.date);
  facts.usage.daily[idx] = { date: judged.day.date, tokens, spendUsd };
  return judged.day.date;
}

describe("a day that is captured, but not whole", () => {
  // Freshness cannot see this: the row is there, written minutes ago, and holds
  // half a day of traffic.
  it("fails when the last closed day came in at a third of the week", () => {
    const facts = healthy();
    expect(setJudgedDay(facts, 3_000_000_000_000, 1_000_000)).toBe("2026-08-14");
    expect(check(facts, "usage.tokens").status).toBe("fail");
    expect(check(facts, "usage.spend").status).toBe("fail");
  });

  it("shrugs at a weekend — 20% below the week in tokens is the market, not a fault", () => {
    const facts = healthy();
    setJudgedDay(facts, 8_000_000_000_000, 2_400_000);
    expect(check(facts, "usage.tokens").status).toBe("ok");
    expect(check(facts, "usage.spend").status).toBe("ok");
  });

  it("fails a day that doubled — the endpoint double-count looked exactly like this", () => {
    const facts = healthy();
    setJudgedDay(facts, 32_000_000_000_000, 16_000_000);
    expect(check(facts, "usage.tokens").status).toBe("fail");
    expect(check(facts, "usage.spend").status).toBe("fail");
  });

  it("fails when a day carries tokens but no dollars at all", () => {
    const facts = healthy();
    setJudgedDay(facts, 10_000_000_000_000, null);
    expect(check(facts, "usage.tokens").status).toBe("ok");
    expect(check(facts, "usage.spend").status).toBe("fail");
  });

  it("judges yesterday when the feed has published it and nothing else", () => {
    const facts = healthy();
    const judged = lastClosedDay(facts.usage.daily, "2026-08-15");
    expect(judged?.day.date).toBe("2026-08-14");
    expect(judged?.baseline).toHaveLength(7);
  });

  it("skips a partial current day a mid-day backfill planted", () => {
    const facts = healthy();
    facts.usage.lastDate = "2026-08-15";
    facts.usage.daily = withPartialToday(healthyDaily());
    const judged = lastClosedDay(facts.usage.daily, "2026-08-15");
    // Half a day sits at the end of the series and must not be the one judged —
    // 5.6T against a 10T week would fail, every time a repair run happened.
    expect(facts.usage.daily[facts.usage.daily.length - 1]!.date).toBe("2026-08-15");
    expect(judged?.day.date).toBe("2026-08-14");
    expect(check(facts, "usage.tokens").status).toBe("ok");
    expect(overallStatus(evaluateChecks(facts))).toBe("ok");
  });

  it("skips rather than guesses on a young deployment", () => {
    const facts = healthy();
    facts.usage.daily = healthyDaily().slice(-3);
    expect(check(facts, "usage.tokens").status).toBe("skip");
    expect(overallStatus(evaluateChecks(facts))).not.toBe("fail");
  });
});

describe("the catalog", () => {
  it("fails when a truncated fetch deactivates a third of the models", () => {
    const facts = healthy();
    facts.catalog.active = 250;
    expect(check(facts, "catalog.size").status).toBe("fail");
  });

  it("warns on a smaller slip", () => {
    const facts = healthy();
    facts.catalog.active = 360;
    expect(check(facts, "catalog.size").status).toBe("warn");
  });

  it("accepts growth without complaint", () => {
    const facts = healthy();
    facts.catalog.active = 480;
    expect(check(facts, "catalog.size").status).toBe("ok");
  });

  it("falls back to an absolute floor before a week of snapshots exists", () => {
    const facts = healthy();
    facts.catalog.activeMedian7d = null;
    facts.catalog.active = 413;
    expect(check(facts, "catalog.size").status).toBe("ok");
    facts.catalog.active = 12;
    expect(check(facts, "catalog.size").status).toBe("fail");
  });
});

describe("vast.ai", () => {
  it("fails when every tracked accelerator comes back empty at once", () => {
    const facts = healthy();
    facts.gpu = { accelerators: 16, withOffers: 0 };
    expect(check(facts, "gpu.offers").status).toBe("fail");
  });

  it("warns when most of the board empties, which supply alone rarely does", () => {
    const facts = healthy();
    facts.gpu = { accelerators: 16, withOffers: 5 };
    expect(check(facts, "gpu.offers").status).toBe("warn");
  });

  it("accepts a few empty accelerators — that is a real observation about supply", () => {
    const facts = healthy();
    facts.gpu = { accelerators: 16, withOffers: 13 };
    expect(check(facts, "gpu.offers").status).toBe("ok");
  });
});

describe("the backup", () => {
  it("fails once the cron has missed a night", () => {
    const facts = healthy();
    facts.backup = { name: "tokens-2026-08-14.sql.7z", ageHours: 27, bytes: 1_400_000 };
    expect(check(facts, "backup.age").status).toBe("warn");
    facts.backup = { name: "tokens-2026-08-13.sql.7z", ageHours: 40, bytes: 1_400_000 };
    expect(check(facts, "backup.age").status).toBe("fail");
  });

  it("fails an archive that shrank to rubble", () => {
    const facts = healthy();
    facts.backup = { name: "tokens-2026-08-15.sql.7z", ageHours: 2, bytes: 4_096 };
    expect(check(facts, "backup.size").status).toBe("fail");
  });

  it("fails a mounted directory that holds no archive at all", () => {
    const facts = healthy();
    facts.backup = { name: null, ageHours: null, bytes: null };
    expect(check(facts, "backup.age").status).toBe("fail");
  });

  it("skips where no backup directory is mounted, rather than failing dev", () => {
    const facts = healthy();
    facts.backup = null;
    expect(check(facts, "backup.age").status).toBe("skip");
    expect(check(facts, "backup.size").status).toBe("skip");
    expect(overallStatus(evaluateChecks(facts))).toBe("ok");
  });
});

describe("overallStatus", () => {
  it("reports the worst status present, and treats skip as harmless", () => {
    expect(overallStatus([])).toBe("ok");
    expect(overallStatus([{ name: "a", status: "ok", detail: "" }])).toBe("ok");
    expect(overallStatus([{ name: "a", status: "skip", detail: "" }])).toBe("ok");
    expect(
      overallStatus([
        { name: "a", status: "ok", detail: "" },
        { name: "b", status: "warn", detail: "" },
      ]),
    ).toBe("warn");
    expect(
      overallStatus([
        { name: "a", status: "warn", detail: "" },
        { name: "b", status: "fail", detail: "" },
      ]),
    ).toBe("fail");
  });
});
