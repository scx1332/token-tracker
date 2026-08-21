import { encodeModelId } from "../routes";
import { useEffect, useMemo, useState } from "react";
import { api, type HealthResponse, type MarketResponse, type RacePoint } from "../api";
import { Kpi, Panel, SectionHead, RankList, Loading, ErrorNote, type RankItem } from "../components";
import { SpendTokensChart, PriceIndexChart, WeeklyBarsChart, ModelRaceChart, ComputeVsTokensChart, C } from "../charts";
import { usd, usdExact, compact, mtok, relTime, seriesChange, displayName, pct, shortDate } from "../format";
import { forecastCurrentWeek, toWeeklyBuckets, trimLeadingPartial } from "../weekly";
import { closedOnly, isClosedDay } from "../runningDay";
import { rankAppsByDaySpend } from "../apps";
import { buildComparison } from "../gpu";
import type { GpuDailyRow } from "../api";

/** The accelerator the market view overlays by default — today's flagship. */
const OVERLAY_GPU = "B200";

export function MarketView({ navigate }: { navigate: (to: string) => void }) {
  const [market, setMarket] = useState<MarketResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Price × volume is the market-share signal that matters, so spend leads.
  const [raceMode, setRaceMode] = useState<"spend" | "tokens">("spend");
  // Days lead: the daily grain is where a launch, a price cut or a routing
  // switch actually shows up on the day it happened. Weekly bars hide that
  // detail inside whichever bar it fell in, and the "trend" they express is
  // one anyone can eyeball from a daily line just as easily. Weeks are still a
  // click away for anyone who wants the weekday noise summed out.
  const [raceBucket, setRaceBucket] = useState<"week" | "day">("day");
  // Stacked lab bars lead: one bar per provider family with its models
  // stacked inside is the "who moved the money" read at a glance, and the
  // stack absorbs a wider model field than lines can carry. Lines stay a
  // click away for following individual trends.
  const [raceStyle, setRaceStyle] = useState<"line" | "bar">("bar");
  // Race points per "bucket:filter" key. Both grains come from the lazy
  // endpoint at a top-50 field — wider than /market's inline top 14 — so the
  // bars' "rest of the field" segment sums real models, not a truncated tail.
  const [raceCache, setRaceCache] = useState<Record<string, RacePoint[]>>({});
  const [raceError, setRaceError] = useState<string | null>(null);
  const [weekMode, setWeekMode] = useState<"spend" | "tokens" | "both">("both");
  const [indexMode, setIndexMode] = useState<"price" | "compute">("price");
  // Apps default to the same day the model leaderboard shows, not the month.
  const [appsMode, setAppsMode] = useState<"day" | "month">("day");
  // Free-tier traffic is volume without a market: default it out of token stats.
  const [includeFree, setIncludeFree] = useState(false);
  const [gpuDaily, setGpuDaily] = useState<GpuDailyRow[]>([]);
  // The race starts Jun 15 2026 — earlier history is noise for today's field.
  const RACE_SINCE = "2026-06-15";
  // How many days of daily bars fit on the row before they stop being bars.
  const BAR_DAYS = 28;

  useEffect(() => {
    let alive = true;
    Promise.all([api.market(120, includeFree), api.health()])
      .then(([m, h]) => {
        if (!alive) return;
        setMarket(m);
        setHealth(h);
      })
      .catch((e) => alive && setError(String(e.message ?? e)));

    // The compute overlay is a secondary source: if vast.ai data is missing the
    // market page must still render, so this failure is swallowed rather than
    // promoted to the page-level error.
    api
      .gpuDaily({ gpu: OVERLAY_GPU, days: 60 })
      .then((g) => alive && setGpuDaily(g.daily))
      .catch(() => alive && setGpuDaily([]));

    return () => {
      alive = false;
    };
  }, [includeFree]);

  // The wide race payload stays off the first /market load and is fetched per
  // grain + free-tier filter — then kept, so flipping back and forth is free.
  const raceKey = `${raceBucket}:${includeFree ? "all" : "paid"}`;
  useEffect(() => {
    if (raceCache[raceKey]) return;
    let alive = true;
    setRaceError(null);
    api
      .race({ bucket: raceBucket, top: 50, includeFree })
      .then((r) => alive && setRaceCache((c) => ({ ...c, [raceKey]: r.points })))
      .catch((e) => alive && setRaceError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [raceBucket, raceKey, raceCache, includeFree]);

  const computeComparison = useMemo(
    () => buildComparison(market?.priceIndex ?? [], gpuDaily, "medianUsd"),
    [market, gpuDaily],
  );

  // Mon–Sun totals of the same daily series (hooks must run before any return).
  // The oldest bucket is short only because coverage starts mid-week, so it goes.
  const weeks = useMemo(() => trimLeadingPartial(toWeeklyBuckets(market?.series ?? [])), [market]);
  const forecast = useMemo(() => {
    const series = market?.series ?? [];
    const now = Date.now();
    return {
      spend: forecastCurrentWeek(series, "spend", now),
      tokens: forecastCurrentWeek(series, "tokens", now),
    };
  }, [market]);

  if (error) return <ErrorNote error={error} />;
  if (!market) return <Loading />;

  const latest = market.latest;
  const series = market.series;
  // Charts get every day, today included and shaded. Anything that compares or
  // averages gets whole days only — see runningDay.ts.
  const closedSeries = closedOnly(series, (s) => s.bucketDate, Date.now());
  const spendSeries = closedSeries.map((s) => s.totalSpendUsd);
  const tokenSeries = closedSeries.map((s) => s.totalTokens);
  const weightedSeries = market.priceIndex.map((s) => s.weightedUsdPerMtok);

  // Week-over-week reads off the last two COMPLETE weeks — the running week is
  // always short and would fake a crash.
  const fullWeeks = weeks.filter((w) => w.complete);
  const lastFullWeek = fullWeeks[fullWeeks.length - 1] ?? null;
  const prevFullWeek = fullWeeks[fullWeeks.length - 2] ?? null;
  // Tokens-only reads tokens; spend and the dual view both headline dollars.
  const weekMetric: "spend" | "tokens" = weekMode === "tokens" ? "tokens" : "spend";
  const weekForecast = weekMetric === "spend" ? forecast.spend : forecast.tokens;
  const weekFmt = (v: number | null) =>
    v === null ? "—" : weekMetric === "spend" ? usd(v) : `${compact(v)} tok`;
  const weekValue = (w: typeof lastFullWeek) => (w ? (weekMetric === "spend" ? w.spendUsd : w.tokens) : null);

  // The footnote reports whatever the chart is showing — both series in "Both".
  const reportedForecasts = (weekMode === "both" ? (["spend", "tokens"] as const) : ([weekMetric] as const))
    .map((metric) => {
      const f = metric === "spend" ? forecast.spend : forecast.tokens;
      if (!f) return null;
      const base = lastFullWeek ? (metric === "spend" ? lastFullWeek.spendUsd : lastFullWeek.tokens) : null;
      return {
        metric,
        label: metric === "spend" ? usd(f.projected) : `${compact(f.projected)} tok`,
        change: base && base > 0 ? f.projected / base - 1 : null,
      };
    })
    .filter((f): f is { metric: "spend" | "tokens"; label: string; change: number | null } => f !== null);
  const prevValue = weekValue(prevFullWeek);
  const weekOverWeek =
    prevValue && prevValue > 0 && weekValue(lastFullWeek) !== null
      ? (weekValue(lastFullWeek)! - prevValue) / prevValue
      : null;

  // Whichever grain is showing, clipped to the window the race covers. Points
  // are absent until the fetch for this grain + filter lands.
  const raceFetched = raceCache[raceKey] ?? null;
  const raceWindow = (raceFetched ?? []).filter((p) => p.date >= RACE_SINCE);
  // Daily bars get a short leash. The full window is ~13 weeks, and 91 groups
  // of 5 bars is ~455 bars across the row — each one a couple of pixels wide,
  // which is a texture, not a chart. Four weeks is what the mark can actually
  // render. Lines stay long: they cross rather than crowd.
  const raceClipsToRecent = raceStyle === "bar" && raceBucket === "day";
  const racePoints = raceClipsToRecent ? raceWindow.slice(-BAR_DAYS) : raceWindow;
  const raceLoading = raceFetched === null && !raceError;

  const priceIndexChange = seriesChange(weightedSeries);
  const spendChange = seriesChange(spendSeries.slice(-14));

  const latestSpend = latest?.totalEstimatedDailySpendUsd ?? null;
  const latestTokens = latest?.totalDailyTokens ?? null;
  const weighted = latest?.usageWeightedPromptUsdPerMtok ?? null;
  const cheapest = latest?.cheapestFrontierUsdPerMtok ?? null;

  // Ranked by est. spend (price × tokens) — free-token volume alone doesn't move money.
  // The leaderboard is one bucket_date deep, and that bucket is whatever
  // `rankings?view=day` last published — normally *yesterday*, since OpenRouter
  // only publishes complete days. Label the day instead of claiming "today".
  const topModelsDate = market.topModels[0]?.bucketDate ?? null;
  const topModelsDayNote = topModelsDate
    ? isClosedDay(topModelsDate, Date.now())
      ? "last complete day"
      : "day still running"
    : null;
  const topModelItems: RankItem[] = market.topModels.slice(0, 15).map((m) => {
    const max = market.topModels[0]?.spendUsd ?? 1;
    return {
      name: displayName(m.name),
      value: m.spendUsd,
      valueLabel: `${usd(m.spendUsd)} · ${compact(m.tokens)} tok`,
      frac: (m.spendUsd ?? 0) / (max || 1),
      href: `/model/${encodeModelId(m.modelId)}`,
      color: C.gold,
    };
  });

  // Per-app spend is assembled from per-model app leaderboards (OpenRouter
  // publishes no direct per-app dollars); fall back to token ranking until
  // the first ingest sweep lands.
  const spendApps = market.appsSpend?.apps ?? [];
  const monthAppItems: RankItem[] = spendApps.length
    ? spendApps.slice(0, 15).map((a) => {
        const max = spendApps[0]?.spendUsd ?? 1;
        return {
          name: a.title,
          value: a.spendUsd,
          valueLabel: `${usd(a.spendUsd)} · ${compact(a.tokens)} tok`,
          frac: (a.spendUsd ?? 0) / (max || 1),
          color: C.gold,
        };
      })
    : (market.apps.month.length ? market.apps.month : market.apps.week).slice(0, 15).map((a, _i, list) => ({
        name: a.title,
        value: a.tokens,
        valueLabel: `${compact(a.tokens)} tok`,
        frac: (a.tokens ?? 0) / ((list[0]?.tokens ?? 1) || 1),
        color: C.gold,
      }));
  const monthAppsNote = spendApps.length
    ? `by est. spend — app tokens priced per model, top ${market.appsSpend?.modelsSwept ?? 0} paid models`
    : "by tokens routed — spend estimate builds after next sync";

  // Day view: the apps feed ships tokens only, so each app's day tokens are
  // priced with its own blended rate from the monthly sweep — see apps.ts.
  const dayApps = rankAppsByDaySpend(market.apps.day, spendApps);
  const dayAppsPriced = dayApps.some((a) => a.spendUsd !== null);
  const dayAppItems: RankItem[] = dayApps.slice(0, 15).map((a, _i, list) => {
    const max = dayAppsPriced ? list[0]?.spendUsd ?? 1 : list[0]?.tokens ?? 1;
    const value = dayAppsPriced ? a.spendUsd ?? 0 : a.tokens;
    return {
      name: a.rateSource === "market" ? `${a.title} *` : a.title,
      value,
      valueLabel: dayAppsPriced ? `${usd(a.spendUsd)} · ${compact(a.tokens)} tok` : `${compact(a.tokens)} tok`,
      frac: value / (max || 1),
      color: C.gold,
    };
  });
  const guessedRates = dayApps.slice(0, 15).filter((a) => a.rateSource === "market").length;
  const dayAppsNote = dayAppsPriced
    ? `est. spend — day tokens × each app's 30-day rate${guessedRates ? ` · * = fleet-average rate (${guessedRates})` : ""}`
    : "by tokens routed — spend estimate builds after next sync";

  const appItems = appsMode === "day" ? dayAppItems : monthAppItems;
  const appsNote = appsMode === "day" ? dayAppsNote : monthAppsNote;

  // "Crash radar": is the usage-weighted price falling and spend still climbing?
  const priceFalling = priceIndexChange !== null && priceIndexChange < -0.01;
  const flag = priceFalling
    ? { color: C.down, label: "Prices sliding — repricing pressure" }
    : spendChange !== null && spendChange > 0.05
      ? { color: C.up, label: "Spend expanding — demand hot" }
      : { color: C.muted, label: "Market steady" };

  return (
    <>
      {/* Hero */}
      <section className="hero">
        <Panel className="hero-lead">
          <div className="signal" style={{ marginBottom: 18 }}>
            <span className="sig-dot" style={{ background: flag.color }} />
            {flag.label}
          </div>
          <h1>
            What the world pays for <span className="c">AI inference</span>.
          </h1>
          <p>
            Every hour this tool scrapes OpenRouter's public pricing and usage — {latest?.activeModels ?? "—"} live
            models across {health?.coverage.pricePoints ?? "—"} price points — to measure spend, throughput, and where
            prices are moving across the model market.
          </p>
          <div className="hero-meta">
            <div className="hm">
              Coverage
              <b className="mono">{health?.coverage.usageDays ?? "—"} days</b>
            </div>
            <div className="hm">
              Last sync
              <b className="mono">{relTime(health?.coverage.lastUsageCapturedAt)}</b>
            </div>
            <div className="hm">
              Models tracked
              <b className="mono">{health?.models.total ?? "—"}</b>
            </div>
          </div>
        </Panel>
        <Panel className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">Estimated daily spend &amp; throughput</div>
              <div className="chart-note">
                tokens × effective paid rate · last 120 days · {includeFree ? "incl. free models" : "paid models only"}
                {series.length > closedSeries.length ? " · dotted leg into the shaded band is today, still counting" : ""}
              </div>
            </div>
            <div className="legend">
              <span>
                <i style={{ background: C.gold }} /> spend
              </span>
              <span>
                <i style={{ background: C.cyan }} /> tokens
              </span>
              <div className="seg seg-sm">
                <button className={!includeFree ? "active" : ""} onClick={() => setIncludeFree(false)}>
                  Paid
                </button>
                <button className={includeFree ? "active" : ""} onClick={() => setIncludeFree(true)}>
                  + Free
                </button>
              </div>
            </div>
          </div>
          <SpendTokensChart series={series} height={268} />
        </Panel>
      </section>

      {/* Weekly bars — the same money, resampled Mon–Sun so the trend shows */}
      <Panel className="chart-card">
        <div className="chart-head">
          <div>
            <div className="chart-title">
              Weekly {weekMode === "both" ? "spend & tokens" : weekMode === "spend" ? "spend" : "tokens"} · Mon–Sun
            </div>
            <div className="chart-note mono">
              {weekMode === "tokens"
                ? "tokens/week"
                : weekMode === "spend"
                  ? "est. $/week"
                  : "est. $/week (left axis) · tokens/week (right axis)"}
              {lastFullWeek ? ` · last full week ${weekFmt(weekValue(lastFullWeek))}` : ""}
              {weekOverWeek !== null ? ` (${pct(weekOverWeek)} w/w)` : ""}
            </div>
          </div>
          <div className="seg seg-sm">
            <button className={weekMode === "spend" ? "active" : ""} onClick={() => setWeekMode("spend")}>
              Est. spend
            </button>
            <button className={weekMode === "tokens" ? "active" : ""} onClick={() => setWeekMode("tokens")}>
              Tokens
            </button>
            <button className={weekMode === "both" ? "active" : ""} onClick={() => setWeekMode("both")}>
              Both
            </button>
          </div>
        </div>
        {weeks.length > 1 ? (
          <WeeklyBarsChart
            weeks={weeks}
            mode={weekMode}
            projected={{ spend: forecast.spend?.projected ?? null, tokens: forecast.tokens?.projected ?? null }}
            height={272}
          />
        ) : (
          <div className="empty">Not enough history for a weekly view yet.</div>
        )}
        {weekForecast ? (
          <div className="forecast-note">
            <div className="fc-head">
              <span className="fc-swatch" />
              <span>
                Week of {weekForecast.weekStart} tracking to{" "}
                {reportedForecasts.map((f, i) => (
                  <span key={f.metric}>
                    {i > 0 ? " · " : ""}
                    <b>{f.label}</b>
                    {f.change !== null ? <span className={f.change >= 0 ? "up" : "down"}> {pct(f.change)}</span> : null}
                  </span>
                ))}{" "}
                vs last full week
              </span>
            </div>
            <div className="fc-method mono">
              {weekFmt(weekForecast.observed)} booked over {weekForecast.daysCovered} day
              {weekForecast.daysCovered === 1 ? "" : "s"} ÷ {(weekForecast.covered * 100).toFixed(0)}% — the share of a
              normal week those weekdays carry, learned from the last {weekForecast.basisWeeks} complete weeks with the
              newest counting heaviest
              {weekForecast.weekendRatio !== null
                ? ` (a weekend day runs ${Math.round((1 - weekForecast.weekendRatio) * 100)}% below a weekday, so the days still to come are not counted flat)`
                : ""}
              .{" "}
              {weekForecast.runningDayValue !== null
                ? `Today's ${weekFmt(weekForecast.runningDayValue)} so far is on the bar but not in that arithmetic — a day still running is never scaled up to a full one.`
                : "OpenRouter publishes complete days only, so today is not booked yet and rides entirely on the projection."}
            </div>
          </div>
        ) : null}
      </Panel>

      {/* KPI row */}
      <div className="grid kpis" style={{ marginTop: 16 }}>
        <Kpi
          label="Est. daily spend"
          dot="gold"
          value={usd(latestSpend)}
          sub={<span className="mono" style={{ color: C.faint }}>{usdExact(latestSpend)} / day</span>}
          spark={spendSeries}
          sparkColor={C.gold}
        />
        <Kpi
          label="Daily tokens"
          dot="cyan"
          value={compact(latestTokens)}
          unit="tok"
          sub={<span className="mono" style={{ color: C.faint }}>across {latest?.activeModels ?? "—"} models</span>}
          spark={tokenSeries}
          sparkColor={C.cyan}
        />
        <Kpi
          label="Price index (wgt.)"
          dot="violet"
          value={mtok(weighted)}
          unit="/M"
          sub={
            priceIndexChange !== null ? (
              <span className={priceIndexChange < 0 ? "up mono" : "down mono"}>
                {priceIndexChange < 0 ? "▼" : "▲"} {Math.abs(priceIndexChange * 100).toFixed(1)}% over window
              </span>
            ) : (
              <span className="mono" style={{ color: C.faint }}>usage-weighted input</span>
            )
          }
          spark={weightedSeries}
          sparkColor={C.violet}
        />
        <Kpi
          label="Cheapest frontier"
          dot="up"
          value={mtok(cheapest)}
          unit="/M"
          sub={<span className="mono" style={{ color: C.faint }}>{latest?.freeModels ?? "—"} models are free</span>}
        />
      </div>

      {/* Price index — solo now that the race sits below on its own row */}
      <div style={{ marginTop: 16 }}>
        <Panel className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">
                {indexMode === "price" ? "Price index over time" : `Tokens vs ${OVERLAY_GPU} rental`}
              </div>
              <div className="chart-note">
                {indexMode === "price"
                  ? "usage-weighted vs median input $/Mtok · daily close"
                  : "both rebased to 100 at window start · index, not level"}
              </div>
            </div>
            <div className="seg seg-sm">
              <button className={indexMode === "price" ? "active" : ""} onClick={() => setIndexMode("price")}>
                Price index
              </button>
              <button
                className={indexMode === "compute" ? "active" : ""}
                onClick={() => setIndexMode("compute")}
                disabled={computeComparison.dates.length < 2}
                title={
                  computeComparison.dates.length < 2
                    ? "Needs GPU snapshots overlapping the token index — builds up daily"
                    : "Compare against raw accelerator rental prices"
                }
              >
                vs compute
              </button>
            </div>
          </div>
          {indexMode === "compute" ? (
            <ComputeVsTokensChart
              dates={computeComparison.dates}
              tokenIndex={computeComparison.tokenIndex}
              gpuIndex={computeComparison.gpuIndex}
              tokenRaw={computeComparison.tokenRaw}
              gpuRaw={computeComparison.gpuRaw}
              gpuLabel={OVERLAY_GPU}
              height={240}
            />
          ) : market.priceIndex.length > 1 ? (
            <PriceIndexChart rows={market.priceIndex} height={240} />
          ) : (
            <div className="empty" style={{ padding: "40px 10px" }}>
              Price-index history builds one point per day — check back tomorrow.
            </div>
          )}
        </Panel>
      </div>

      {/* Model race — full width so ten lines (or five grouped bars per bucket)
          have room to spread out and legends can wrap without stealing plot */}
      <div style={{ marginTop: 16 }}>
        <Panel className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">The model race</div>
              <div className="chart-note">
                {raceMode === "spend" ? "est. spend" : "tokens"} per {raceBucket} ·{" "}
                {raceBucket === "week" ? "full weeks only" : "one point per day"} ·{" "}
                {raceStyle === "bar" ? "one bar per lab · top 12 + rest of the top 50" : "top 10"} ·{" "}
                {/* The field is ranked over exactly what's drawn, so the note
                    names the drawn window rather than the fetched one. */}
                {raceClipsToRecent
                  ? `last ${BAR_DAYS} days`
                  : `since ${shortDate(racePoints[0]?.date ?? RACE_SINCE)}`}
              </div>
            </div>
            <div className="seg-row">
              <div className="seg seg-sm">
                <button className={raceMode === "spend" ? "active" : ""} onClick={() => setRaceMode("spend")}>
                  Est. spend
                </button>
                <button className={raceMode === "tokens" ? "active" : ""} onClick={() => setRaceMode("tokens")}>
                  Tokens
                </button>
              </div>
              <div className="seg seg-sm">
                <button
                  className={raceBucket === "day" ? "active" : ""}
                  onClick={() => setRaceBucket("day")}
                  title="One point per day — a launch or routing switch lands on the day it happened"
                >
                  Daily
                </button>
                <button
                  className={raceBucket === "week" ? "active" : ""}
                  onClick={() => setRaceBucket("week")}
                  title="Full ISO weeks — the trend, with weekday noise summed out"
                >
                  Weekly
                </button>
              </div>
              <div className="seg seg-sm">
                <button
                  className={raceStyle === "line" ? "active" : ""}
                  onClick={() => setRaceStyle("line")}
                  title="Ten model trends over time"
                >
                  Lines
                </button>
                <button
                  className={raceStyle === "bar" ? "active" : ""}
                  onClick={() => setRaceStyle("bar")}
                  title="One stacked bar per lab — Anthropic, OpenAI, X.AI, Z.AI, Others — with each lab's models stacked inside it"
                >
                  Bars · by lab
                </button>
              </div>
            </div>
          </div>
          {raceLoading ? (
            // Hold the plot's height so switching grain doesn't bounce the row.
            <div style={{ height: 380, display: "grid", placeItems: "center" }}>
              <Loading label="Loading the race…" />
            </div>
          ) : raceError ? (
            <div className="empty" style={{ padding: "40px 10px" }}>Race unavailable — {raceError}</div>
          ) : racePoints.length > 1 ? (
            <ModelRaceChart
              points={racePoints}
              height={380}
              topN={raceStyle === "bar" ? 12 : 10}
              mode={raceMode}
              bucket={raceBucket}
              style={raceStyle}
            />
          ) : (
            <div className="empty" style={{ padding: "40px 10px" }}>
              No {raceBucket === "week" ? "weekly" : "daily"} history yet.
            </div>
          )}
        </Panel>
      </div>

      {/* Leaderboards */}
      <SectionHead eyebrow="Order flow" title="Who moves the tokens" />
      <div className="two-col">
        <Panel className="panel-pad">
          <div className="chart-head">
            <div className="chart-title">Top models · {topModelsDate ? shortDate(topModelsDate) : "—"}</div>
            <div className="chart-note">
              by est. daily spend (tokens × effective rate){topModelsDayNote ? ` · ${topModelsDayNote}` : ""}
            </div>
          </div>
          <RankList items={topModelItems} onNavigate={navigate} />
        </Panel>
        <Panel className="panel-pad">
          <div className="chart-head">
            <div>
              <div className="chart-title">Top apps · {appsMode === "day" ? "latest day" : "30 days"}</div>
              <div className="chart-note">{appsNote}</div>
            </div>
            <div className="seg seg-sm">
              <button
                className={appsMode === "day" ? "active" : ""}
                onClick={() => setAppsMode("day")}
                disabled={!market.apps.day.length}
                title={
                  market.apps.day.length
                    ? "The apps feed's latest full day — undated, but the same bucket the models list is dated by"
                    : "No day bucket in the apps feed yet"
                }
              >
                Day
              </button>
              <button className={appsMode === "month" ? "active" : ""} onClick={() => setAppsMode("month")}>
                30 days
              </button>
            </div>
          </div>
          {appItems.length ? <RankList items={appItems} /> : <div className="empty">No app data.</div>}
        </Panel>
      </div>
    </>
  );
}
