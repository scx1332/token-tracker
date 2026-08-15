// Production checks: is the deployment still doing its job?
//
// `bun test` proves the code is right. This proves the *running system* is
// alive — that every scraper still lands rows, that the last closed day's
// numbers are the right size, that history has no holes in it, that the backup
// ran. A scraper failing is rarely a crash: the process stays up, the pass
// still reports `ok`, and the only symptom is one source quietly ceasing to
// advance while every page still renders yesterday's data. That silence is
// what this file listens for.
//
// Pure on purpose. `/status` evaluates these against the live database,
// `src/production.test.ts` asserts on that verdict from outside the host, and
// `src/monitor.test.ts` runs them against fixtures of every failure mode — so
// the alarm is tested rather than trusted. An untested alarm is worse than no
// alarm, because it reads as coverage.
//
// Severity has exactly one rule:
//
//   fail — data is being lost right now, or a number on the site is wrong.
//   warn — unusual, worth a look, but nothing is lost by waiting.
//   skip — the fact needed to judge it is not available here.
//
// Anything OpenRouter or vast.ai may legitimately do on a quiet day is a warn
// at most. An alarm that cries wolf gets muted, and a muted alarm is how a
// scraper stays down for a week without anyone noticing.

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  /** Stable identifier — `src/production.test.ts` names one test per check. */
  name: string;
  status: CheckStatus;
  /** What was observed and what was expected. One line, always populated. */
  detail: string;
}

/** Model-level (`provider = ''`) daily totals — one row per bucket_date. */
export interface UsageDay {
  date: string;
  tokens: number | null;
  spendUsd: number | null;
}

/**
 * Everything the checks are allowed to look at. Collected by
 * `Storage.getMonitorFacts()` (plus the backup directory listing) and handed
 * over as plain data, so a fixture is as good as a live database.
 */
export interface MonitorFacts {
  /** When the facts were read, ISO-8601 Z. Every age below is measured from here. */
  nowUtc: string;
  ingest: {
    lastStartedAt: string | null;
    lastStatus: string | null;
    lastError: string | null;
    /** Statuses of the most recent finished runs, newest first. */
    recentStatuses: string[];
    /** Counters from the newest run that finished cleanly. */
    lastOk: { startedAt: string; modelsSeen: number | null; usageRows: number | null } | null;
  };
  /** Newest write per source, ISO-8601 Z; null when the table is empty. */
  latest: {
    catalog: string | null;
    priceChange: string | null;
    usageModel: string | null;
    usageProvider: string | null;
    effectivePrice: string | null;
    providerVolume: string | null;
    marketSnapshot: string | null;
    gpuSweep: string | null;
  };
  catalog: {
    total: number;
    active: number;
    /** Median `active_models` over the last week of hourly market snapshots. */
    activeMedian7d: number | null;
  };
  usage: {
    firstDate: string | null;
    lastDate: string | null;
    /** Dates between first and last carrying no model-level row at all. */
    missingDates: string[];
    /** Model-level daily totals, oldest first. Only the tail is needed. */
    daily: UsageDay[];
  };
  /** The newest GPU sweep: rows written, and how many found any offer. */
  gpu: { accelerators: number; withOffers: number };
  /** The backup directory, or null where none is mounted (dev, CI). */
  backup: BackupFact | null;
}

export interface BackupFact {
  /** Newest archive, or null when the directory is mounted but empty. */
  name: string | null;
  ageHours: number | null;
  bytes: number | null;
}

/** The half of the facts that comes out of Postgres — see `Storage.getMonitorFacts`. */
export type MonitorDbFacts = Omit<MonitorFacts, "backup">;

interface Limits {
  warn: number;
  fail: number;
}

/**
 * Usage history's first day. Coverage opened Friday 2026-05-15, but that left a
 * three-day stub in front of the first full Mon–Sun week and it had already
 * aged out of `provider-token-chart`'s ~90-day window, so it was deleted on
 * 2026-05-18's side of the line (knowledge.md §1). Nothing can re-fetch a day
 * older than that window at any price, which is exactly why the floor is
 * asserted: if it ever moves forward, unrecoverable history has been dropped.
 */
export const USAGE_HISTORY_FLOOR = "2026-05-18";

/**
 * How stale each source may get, in hours.
 *
 * Every one of these comes from the source's real cadence, not from taste:
 * the OpenRouter pass runs hourly (`INGEST_INTERVAL_MS`), the per-provider and
 * effective-price sweep is gated to once a day (`PROVIDER_USAGE_MIN_GAP_MS`,
 * 20h), vast.ai sweeps every 15 minutes (`INGEST_GPU_INTERVAL_MS`), and the
 * backup cron fires at 03:30 Europe/Berlin. `warn` is one missed cycle, `fail`
 * is enough missed cycles that it cannot be a blip.
 */
export const STALENESS: Record<string, Limits> = {
  /** Written by every pass. */
  hourly: { warn: 2, fail: 3 },
  /** The once-a-day sweep: ~21h spacing in practice, two missed = ~42h. */
  daily: { warn: 26, fail: 50 },
  /** 15-minute clock, so an hour of silence is already four missed sweeps. */
  gpu: { warn: 0.75, fail: 1.5 },
  /**
   * Prices are a change-log, so silence is legal in a way it is not elsewhere —
   * but the live market has produced ~160 changes every single hour since
   * launch, so a quiet quarter-day is already strange and a quiet day means the
   * price parsing broke while the pass kept reporting success.
   */
  priceChange: { warn: 6, fail: 24 },
  /** 24h between cron runs, plus room for a slow dump. */
  backup: { warn: 26, fail: 30 },
};

/** Days of history the last closed day is judged against. */
const BASELINE_DAYS = 7;

/**
 * How far the last closed day may drift from that baseline before it is a
 * problem. Both sides matter: an under-read is a partial capture, and an
 * over-read is a double count — the endpoint bug that inflated Anthropic
 * history 2–2.5×, and the list-price restatement that would have run ~6× high,
 * would both have shown up here (AGENTS.md, knowledge.md §4).
 *
 * The bands are wide because the market itself moves: a weekend day runs ~20%
 * below a weekday in tokens and ~35% in dollars, and tokens have grown ~5% a
 * day, which a trailing median lags by half a window.
 */
// Observed day-against-median ratios have stayed inside [0.78, 1.43] since
// launch, so `warn` at half or double is already well outside the market, and
// `fail` at a third or triple is not something a market does at all. Dollars
// get more room on the high side than tokens: the double count showed up as
// 2–2.5× in tokens but priced at list it would have read ~6×.
const TOKEN_BAND = { failLow: 0.35, warnLow: 0.6, warnHigh: 2, failHigh: 3 };
const SPEND_BAND = { failLow: 0.35, warnLow: 0.5, warnHigh: 2, failHigh: 4 };

/** The catalog shrinking means a truncated fetch deactivated real models. */
const CATALOG_BAND = { failLow: 0.7, warnLow: 0.9 };

/** Below this the catalog is not "small", it is broken. OpenRouter lists ~400. */
const CATALOG_FLOOR = 100;

/** A 7z of the whole database has never been under a megabyte; 100 KB is rubble. */
const BACKUP_MIN_BYTES = 100_000;

export function evaluateChecks(facts: MonitorFacts): Check[] {
  const now = Date.parse(facts.nowUtc);
  return [
    ingestPass(facts, now),
    ingestResult(facts),
    ingestRows(facts),
    fresh("catalog.scrape", facts.latest.catalog, now, STALENESS.hourly!, "catalog row"),
    catalogSize(facts),
    fresh("usage.rankings", facts.latest.usageModel, now, STALENESS.hourly!, "model-level usage row"),
    usageDay(facts, now),
    usageGaps(facts),
    usageFloor(facts),
    ...usageVolume(facts, now),
    fresh("usage.providers", facts.latest.usageProvider, now, STALENESS.daily!, "per-provider usage row"),
    fresh("prices.effective", facts.latest.effectivePrice, now, STALENESS.daily!, "effective-price row"),
    fresh("prices.changes", facts.latest.priceChange, now, STALENESS.priceChange!, "price change"),
    fresh("providers.volume", facts.latest.providerVolume, now, STALENESS.hourly!, "provider-volume row"),
    fresh("market.snapshot", facts.latest.marketSnapshot, now, STALENESS.hourly!, "market snapshot"),
    fresh("gpu.sweep", facts.latest.gpuSweep, now, STALENESS.gpu!, "vast.ai sweep"),
    gpuOffers(facts),
    backupAge(facts),
    backupSize(facts),
  ];
}

/** Worst status across the checks — what `/status` reports and CI exits on. */
export function overallStatus(checks: Check[]): CheckStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "ok";
}

// ---------------------------------------------------------------------------
// Freshness — "has this source written anything lately"
// ---------------------------------------------------------------------------

/**
 * The shape most of these checks take: one source, one newest-write timestamp.
 * A source that has never written anything fails outright rather than being
 * treated as infinitely stale, because "never" and "stopped" want different
 * fixes and the detail line is the only thing anyone reads at 3am.
 */
function fresh(name: string, at: string | null, now: number, limits: Limits, what: string): Check {
  if (!at) return { name, status: "fail", detail: `no ${what} has ever been written` };
  const hours = hoursSince(at, now);
  if (hours === null) return { name, status: "fail", detail: `newest ${what} has an unreadable timestamp: ${at}` };
  const detail = `newest ${what} is ${formatAge(hours)} old (${at}) — warn at ${limits.warn}h, fail at ${limits.fail}h`;
  if (hours >= limits.fail) return { name, status: "fail", detail };
  if (hours >= limits.warn) return { name, status: "warn", detail };
  return { name, status: "ok", detail };
}

// ---------------------------------------------------------------------------
// The ingest loop itself
// ---------------------------------------------------------------------------

function ingestPass(facts: MonitorFacts, now: number): Check {
  return fresh("ingest.pass", facts.ingest.lastStartedAt, now, STALENESS.hourly!, "ingest pass");
}

/**
 * One failed pass is ordinary: OpenRouter rate-limits, a fetch times out, and
 * the next pass an hour later refills everything the failed one missed. Two in
 * a row is not weather, it is a broken build or a changed endpoint.
 */
function ingestResult(facts: MonitorFacts): Check {
  const name = "ingest.result";
  const finished = facts.ingest.recentStatuses.filter((s) => s === "ok" || s === "error");
  if (finished.length === 0) return { name, status: "fail", detail: "no ingest pass has ever finished" };

  const errors = finished.filter((s) => s === "error").length;
  const window = `${errors}/${finished.length} recent passes failed`;
  const because = facts.ingest.lastError ? ` — last error: ${truncate(facts.ingest.lastError, 200)}` : "";
  const backToBack = finished[0] === "error" && finished[1] === "error";

  if (backToBack || errors >= 3) return { name, status: "fail", detail: `${window}${because}` };
  if (errors > 0) return { name, status: "warn", detail: `${window}${because}` };
  return { name, status: "ok", detail: `last ${finished.length} passes all finished ok` };
}

/**
 * A pass can succeed and still bring nothing home — that is precisely what a
 * changed upstream response shape looks like from in here. The counters the
 * pass recorded are the earliest possible warning, an hour ahead of any
 * staleness threshold.
 */
function ingestRows(facts: MonitorFacts): Check {
  const name = "ingest.rows";
  const ok = facts.ingest.lastOk;
  if (!ok) return { name, status: "fail", detail: "no ingest pass has ever succeeded" };
  const detail = `last successful pass (${ok.startedAt}) saw ${ok.modelsSeen ?? 0} models and wrote ${ok.usageRows ?? 0} usage rows`;
  if (!ok.modelsSeen || !ok.usageRows) return { name, status: "fail", detail };
  return { name, status: "ok", detail };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Models missing from a catalog fetch get deactivated, so a truncated response
 * silently empties the site. Judged against the last week of hourly snapshots
 * rather than a fixed number: the catalog grows, and a threshold that has to be
 * hand-raised is a threshold that eventually gets ignored.
 */
function catalogSize(facts: MonitorFacts): Check {
  const name = "catalog.size";
  const { active, total, activeMedian7d } = facts.catalog;
  if (active < CATALOG_FLOOR) {
    return { name, status: "fail", detail: `only ${active} active models of ${total} — floor is ${CATALOG_FLOOR}` };
  }
  if (activeMedian7d === null || activeMedian7d <= 0) {
    return { name, status: "ok", detail: `${active} active models of ${total}; no week of snapshots to compare against yet` };
  }
  const ratio = active / activeMedian7d;
  const detail = `${active} active models of ${total} — ${ratio.toFixed(2)}× the 7-day median of ${activeMedian7d}`;
  if (ratio < CATALOG_BAND.failLow) return { name, status: "fail", detail };
  if (ratio < CATALOG_BAND.warnLow) return { name, status: "warn", detail };
  return { name, status: "ok", detail };
}

// ---------------------------------------------------------------------------
// Usage — the series that cannot be re-fetched once its window slides
// ---------------------------------------------------------------------------

/**
 * The newest bucket_date, which is a different question from whether rows are
 * being written: rows can keep landing with stale dates if OpenRouter's own
 * pipeline stalls, or if our date handling breaks.
 *
 * **Yesterday is the healthy answer, not today.** `rankings/models?view=day`
 * serves exactly one date — the day that has ended — and flips to the next one
 * within an hour of UTC midnight, so a model-level row for the current day only
 * exists when a mid-day `bun run backfill` has planted a partial one from
 * provider-token-chart. Two days behind means the flip was missed entirely.
 */
function usageDay(facts: MonitorFacts, now: number): Check {
  const name = "usage.day";
  const last = facts.usage.lastDate;
  if (!last) return { name, status: "fail", detail: "usage_snapshots holds no model-level rows at all" };
  const behind = dayIndex(utcDate(now)) - dayIndex(last);
  const detail = `newest usage bucket is ${last}, ${behind} day(s) behind ${utcDate(now)} (1 is normal — the feed publishes a day once it has ended)`;
  if (behind >= 3) return { name, status: "fail", detail };
  if (behind >= 2) return { name, status: "warn", detail };
  return { name, status: "ok", detail };
}

/**
 * A hole in the series is the literal shape of "the scraper was down for a
 * day". It is also permanent: the one-time backfill has already run, and
 * `provider-token-chart`'s window slides a day per day, so a day missed today
 * is a day missing from the charts forever.
 */
function usageGaps(facts: MonitorFacts): Check {
  const name = "usage.gaps";
  const missing = facts.usage.missingDates;
  if (!facts.usage.firstDate || !facts.usage.lastDate) {
    // `usage.day` and `usage.floor` already say so; an empty table has no holes.
    return { name, status: "skip", detail: "there is no usage history to find holes in" };
  }
  const span = `${facts.usage.firstDate} .. ${facts.usage.lastDate}`;
  if (missing.length === 0) return { name, status: "ok", detail: `no missing days across ${span}` };
  return {
    name,
    status: "fail",
    detail: `${missing.length} day(s) with no usage rows: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}`,
  };
}

/** History must not lose its floor — see `USAGE_HISTORY_FLOOR`. */
function usageFloor(facts: MonitorFacts): Check {
  const name = "usage.floor";
  const first = facts.usage.firstDate;
  if (!first) return { name, status: "fail", detail: "usage_snapshots holds no model-level rows at all" };
  if (first === USAGE_HISTORY_FLOOR) return { name, status: "ok", detail: `history still starts at ${first}` };
  if (first > USAGE_HISTORY_FLOOR) {
    return {
      name,
      status: "fail",
      detail: `history now starts at ${first}, ${dayIndex(first) - dayIndex(USAGE_HISTORY_FLOOR)} day(s) after the ${USAGE_HISTORY_FLOOR} floor — those days cannot be re-fetched`,
    };
  }
  return { name, status: "warn", detail: `history starts at ${first}, before the ${USAGE_HISTORY_FLOOR} floor — where did it come from?` };
}

/**
 * Size the last closed day against the week before it, in both tokens and
 * dollars. Freshness says rows arrived; this says they arrived *whole*. A
 * capture that dies halfway through a day still writes a perfectly fresh row
 * holding half a day's traffic, and nothing else here would notice.
 */
function usageVolume(facts: MonitorFacts, now: number): Check[] {
  const judged = lastClosedDay(facts.usage.daily, utcDate(now));
  if (!judged) {
    const detail = `need ${BASELINE_DAYS} days of history plus a closed day to judge against; have ${facts.usage.daily.length}`;
    return [
      { name: "usage.tokens", status: "skip", detail },
      { name: "usage.spend", status: "skip", detail },
    ];
  }
  const { day, baseline } = judged;
  return [
    ratio("usage.tokens", `tokens on ${day.date}`, day.tokens, median(baseline.map((d) => d.tokens)), TOKEN_BAND, compact),
    ratio("usage.spend", `est. spend on ${day.date}`, day.spendUsd, median(baseline.map((d) => d.spendUsd)), SPEND_BAND, usd),
  ];
}

/**
 * The newest day that has ended. Usually that is the newest bucket outright,
 * because the feed only publishes closed days — but a mid-day `bun run
 * backfill` plants a partial current day from provider-token-chart, and judging
 * half a day against seven whole ones would fail every time it happened.
 */
export function lastClosedDay(daily: UsageDay[], todayUtc: string): { day: UsageDay; baseline: UsageDay[] } | null {
  let idx = -1;
  for (let i = daily.length - 1; i >= 0; i -= 1) {
    if (daily[i]!.date < todayUtc) {
      idx = i;
      break;
    }
  }
  if (idx < 1) return null;
  const day = daily[idx]!;
  const baseline = daily.slice(Math.max(0, idx - BASELINE_DAYS), idx);
  if (baseline.length < 3) return null;
  return { day, baseline };
}

interface Band {
  failLow: number;
  warnLow: number;
  warnHigh: number;
  failHigh: number;
}

function ratio(
  name: string,
  label: string,
  value: number | null,
  baseline: number | null,
  band: Band,
  format: (n: number) => string,
): Check {
  if (value === null || value <= 0) return { name, status: "fail", detail: `${label}: nothing recorded` };
  if (baseline === null || baseline <= 0) {
    return { name, status: "ok", detail: `${label}: ${format(value)}; no baseline to compare against yet` };
  }
  const r = value / baseline;
  const detail = `${label}: ${format(value)} — ${r.toFixed(2)}× the ${BASELINE_DAYS}-day median of ${format(baseline)}`;
  if (r < band.failLow || r > band.failHigh) return { name, status: "fail", detail };
  if (r < band.warnLow || r > band.warnHigh) return { name, status: "warn", detail };
  return { name, status: "ok", detail };
}

// ---------------------------------------------------------------------------
// GPU + backup
// ---------------------------------------------------------------------------

/**
 * A GPU with no offers is a real observation about supply, so zero-depth rows
 * are stored deliberately (AGENTS.md) — but *every* tracked accelerator empty
 * at once is not a market event, it is a changed search API or a wrong
 * `gpu_name`, which fails silently by design and would otherwise just look like
 * a flat line on the chart.
 */
function gpuOffers(facts: MonitorFacts): Check {
  const name = "gpu.offers";
  const { accelerators, withOffers } = facts.gpu;
  if (accelerators === 0) return { name, status: "fail", detail: "the newest vast.ai sweep wrote no rows" };
  const detail = `${withOffers} of ${accelerators} accelerators had offers in the newest sweep`;
  if (withOffers === 0) return { name, status: "fail", detail };
  if (withOffers < accelerators / 2) return { name, status: "warn", detail };
  return { name, status: "ok", detail };
}

function backupAge(facts: MonitorFacts): Check {
  const name = "backup.age";
  if (!facts.backup) return { name, status: "skip", detail: "no backup directory is mounted here" };
  const { name: file, ageHours } = facts.backup;
  if (file === null || ageHours === null) {
    return { name, status: "fail", detail: "the backup directory is mounted but holds no archive" };
  }
  const limits = STALENESS.backup!;
  const detail = `newest archive ${file} is ${formatAge(ageHours)} old — warn at ${limits.warn}h, fail at ${limits.fail}h`;
  if (ageHours >= limits.fail) return { name, status: "fail", detail };
  if (ageHours >= limits.warn) return { name, status: "warn", detail };
  return { name, status: "ok", detail };
}

/**
 * `scripts/backup-db.sh` already refuses to keep a dump without pg_dump's
 * completion marker, and round-trips the archive before moving it into place.
 * This is the outside check on all of that: an archive that shrank to nothing
 * means the pipeline found a way to write rubble anyway.
 */
function backupSize(facts: MonitorFacts): Check {
  const name = "backup.size";
  if (!facts.backup) return { name, status: "skip", detail: "no backup directory is mounted here" };
  const { name: file, bytes } = facts.backup;
  if (file === null || bytes === null) return { name, status: "skip", detail: "no archive to size" };
  const detail = `${file} is ${(bytes / 1_048_576).toFixed(2)} MB — floor is ${(BACKUP_MIN_BYTES / 1000).toFixed(0)} KB`;
  return { name, status: bytes < BACKUP_MIN_BYTES ? "fail" : "ok", detail };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hoursSince(iso: string, now: number): number | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return (now - at) / 3_600_000;
}

/** Whole days since the epoch for a `YYYY-MM-DD` string — date maths, no clock. */
function dayIndex(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function median(values: (number | null)[]): number | null {
  const sorted = values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function compact(n: number): string {
  const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [scale, suffix] of units) if (Math.abs(n) >= scale) return `${(n / scale).toFixed(2)}${suffix}`;
  return n.toFixed(0);
}

function usd(n: number): string {
  return `$${compact(n)}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
