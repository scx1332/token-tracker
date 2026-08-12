import { useEffect, useState } from "react";
import { api, type HealthResponse, type MarketResponse } from "../api";
import { Kpi, Panel, SectionHead, RankList, Loading, ErrorNote, type RankItem } from "../components";
import { SpendTokensChart, PriceIndexChart, WeeklyRaceChart, C } from "../charts";
import { usd, usdExact, compact, mtok, relTime, seriesChange, displayName } from "../format";

export function MarketView({ navigate }: { navigate: (to: string) => void }) {
  const [market, setMarket] = useState<MarketResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.market(120), api.health()])
      .then(([m, h]) => {
        if (!alive) return;
        setMarket(m);
        setHealth(h);
      })
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <ErrorNote error={error} />;
  if (!market) return <Loading />;

  const latest = market.latest;
  const series = market.series;
  const spendSeries = series.map((s) => s.totalSpendUsd);
  const tokenSeries = series.map((s) => s.totalTokens);
  const weightedSeries = market.snapshots.map((s) => s.usageWeightedPromptUsdPerMtok);

  const priceIndexChange = seriesChange(weightedSeries);
  const spendChange = seriesChange(spendSeries.slice(-14));

  const latestSpend = latest?.totalEstimatedDailySpendUsd ?? null;
  const latestTokens = latest?.totalDailyTokens ?? null;
  const weighted = latest?.usageWeightedPromptUsdPerMtok ?? null;
  const cheapest = latest?.cheapestFrontierUsdPerMtok ?? null;

  const topModelItems: RankItem[] = market.topModels.slice(0, 10).map((m) => {
    const max = market.topModels[0]?.tokens ?? 1;
    return {
      name: displayName(m.name),
      value: m.tokens,
      valueLabel: `${compact(m.tokens)} · ${usd(m.spendUsd)}`,
      frac: (m.tokens ?? 0) / (max || 1),
      href: `#/model/${encodeURIComponent(m.modelId)}`,
      color: C.cyan,
    };
  });

  const apps = market.apps.month.length ? market.apps.month : market.apps.week;
  const appItems: RankItem[] = apps.slice(0, 10).map((a) => {
    const max = apps[0]?.tokens ?? 1;
    return {
      name: a.title,
      value: a.tokens,
      valueLabel: `${compact(a.tokens)} tok`,
      frac: (a.tokens ?? 0) / (max || 1),
      color: C.gold,
    };
  });

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
          <div className="crash-flag" style={{ marginBottom: 18 }}>
            <span className="pulse" style={{ background: flag.color }} />
            {flag.label}
          </div>
          <h1>
            The price of <span className="c">thinking</span>, <span className="g">quoted live.</span>
          </h1>
          <p>
            Every hour we scrape OpenRouter's public order book — {latest?.activeModels ?? "—"} live models across{" "}
            {health?.coverage.pricePoints ?? "—"} price points — to chart what the world pays to run frontier AI, and
            where the next repricing is coming from.
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
              <div className="chart-note">tokens × current price · last 120 days</div>
            </div>
            <div className="legend">
              <span>
                <i style={{ background: C.gold }} /> spend
              </span>
              <span>
                <i style={{ background: C.cyan }} /> tokens
              </span>
            </div>
          </div>
          <SpendTokensChart series={series} height={268} />
        </Panel>
      </section>

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

      {/* Price index + weekly race */}
      <div className="grid chart-grid" style={{ marginTop: 16 }}>
        <Panel className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">Price index over time</div>
              <div className="chart-note">usage-weighted vs median input $/Mtok</div>
            </div>
            <div className="legend">
              <span>
                <i style={{ background: C.gold }} /> weighted
              </span>
              <span>
                <i style={{ background: C.violet }} /> median
              </span>
            </div>
          </div>
          {market.snapshots.length > 1 ? (
            <PriceIndexChart snapshots={market.snapshots} height={240} />
          ) : (
            <div className="empty" style={{ padding: "40px 10px" }}>
              Price-index history builds as hourly snapshots accumulate.
            </div>
          )}
        </Panel>
        <Panel className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">The model race</div>
              <div className="chart-note">weekly tokens · top models · 1 year</div>
            </div>
          </div>
          {market.weekly.points.length > 1 ? (
            <WeeklyRaceChart points={market.weekly.points} height={240} />
          ) : (
            <div className="empty" style={{ padding: "40px 10px" }}>No weekly history yet.</div>
          )}
        </Panel>
      </div>

      {/* Leaderboards */}
      <SectionHead eyebrow="Order flow" title="Who moves the tokens" />
      <div className="two-col">
        <Panel className="panel-pad">
          <div className="chart-head">
            <div className="chart-title">Top models · today</div>
            <div className="chart-note">by daily tokens</div>
          </div>
          <RankList items={topModelItems} onNavigate={navigate} />
        </Panel>
        <Panel className="panel-pad">
          <div className="chart-head">
            <div className="chart-title">Top apps · 30 days</div>
            <div className="chart-note">by tokens routed</div>
          </div>
          {appItems.length ? <RankList items={appItems} /> : <div className="empty">No app data.</div>}
        </Panel>
      </div>
    </>
  );
}
