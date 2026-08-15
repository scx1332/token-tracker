import { useEffect, useMemo, useState } from "react";
import {
  api,
  type AcceleratorWithLatest,
  type GpuDailyRow,
  type GpuPriceRow,
  type MarketRow,
  type PriceIndexPoint,
} from "../api";
import { Loading, ErrorNote, Panel, Delta, Kpi } from "../components";
import {
  GpuBandChart,
  ComputeVsTokensChart,
  IntradayTapeChart,
  HourProfileChart,
  Sparkline,
  C,
  DEPTH_AXIS,
} from "../charts";
import { compact } from "../format";
import {
  groupDailyByGpu,
  lastWindow,
  hourOfDayProfile,
  buildComparison,
  buildHourlyComparison,
  totalChangePct,
} from "../gpu";

const TIER_LABEL: Record<string, string> = {
  flagship: "Flagship",
  datacenter: "Datacenter",
  prosumer: "Prosumer",
};

const TIER_ORDER = ["flagship", "datacenter", "prosumer"];

/** Days of daily history before the rental-price chart trades sweeps for dailies. */
const DAILY_MIN_DAYS = 7;

/** $/GPU-hour to 3dp — rentals span $0.06 to $10, so a fixed 3 reads cleanly. */
function gpuHr(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `$${v.toFixed(3)}`;
}

export function ComputeView({ navigate: _navigate }: { navigate: (to: string) => void }) {
  const [accelerators, setAccelerators] = useState<AcceleratorWithLatest[] | null>(null);
  const [dailyAll, setDailyAll] = useState<GpuDailyRow[] | null>(null);
  const [priceIndex, setPriceIndex] = useState<PriceIndexPoint[] | null>(null);
  const [snapshots, setSnapshots] = useState<MarketRow[]>([]);
  const [hourly, setHourly] = useState<GpuPriceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("B200");
  const [metric, setMetric] = useState<"minUsd" | "medianUsd">("medianUsd");

  useEffect(() => {
    let alive = true;
    Promise.all([api.gpu(), api.gpuDaily({ days: 30 }), api.market(120)])
      .then(([g, d, m]) => {
        if (!alive) return;
        setAccelerators(g.accelerators);
        setDailyAll(d.daily);
        setPriceIndex(m.priceIndex);
      })
      .catch((e) => alive && setError(String(e.message ?? e)));
    // Hourly token snapshots power the hour-of-day profile; the page must
    // still render if this secondary fetch fails.
    api
      .marketSnapshots(14)
      .then((s) => alive && setSnapshots(s.snapshots))
      .catch(() => alive && setSnapshots([]));
    return () => {
      alive = false;
    };
  }, []);

  // The intraday tape and profile follow the selected accelerator.
  useEffect(() => {
    let alive = true;
    setHourly(null);
    api
      .gpuSeries({ gpu: selected, days: 14 })
      .then((s) => alive && setHourly(s.series))
      .catch(() => alive && setHourly([]));
    return () => {
      alive = false;
    };
  }, [selected]);

  const dailyByGpu = useMemo(() => groupDailyByGpu(dailyAll ?? []), [dailyAll]);
  const dailySelected = dailyByGpu.get(selected) ?? [];

  // Daily bands are the long-run view, but with under a week of history a daily
  // chart is two lonely points. Until then, chart every 15-min sweep instead —
  // the detail exists, so show it. Daily takes over once it can carry the story.
  const bandHourly = dailySelected.length < DAILY_MIN_DAYS;
  const bandPoints = useMemo(() => {
    const rows = hourly ?? [];
    if (!bandHourly || !rows.length) return dailySelected;
    return rows.map((r) => ({
      date: r.capturedAt,
      minUsd: r.minUsd,
      medianUsd: r.medianUsd,
      p25Usd: r.p25Usd,
      gpusAvailable: r.gpusAvailable,
    }));
    // dailySelected is derived per render; selected covers it in the dep list.
  }, [bandHourly, hourly, dailyAll, selected]);

  // Same maturity switch as the rental chart: with under a week of shared
  // daily history the comparison is two points pretending to be a trend, so
  // build it from hourly token snapshots × 15-min GPU sweeps until dailies
  // can carry it.
  const dailyComparison = useMemo(
    () => buildComparison(priceIndex ?? [], dailySelected, metric),
    [priceIndex, dailyByGpu, selected, metric],
  );
  const comparisonHourly = dailyComparison.dates.length < DAILY_MIN_DAYS;
  const comparison = useMemo(
    () =>
      comparisonHourly
        ? buildHourlyComparison(snapshots, hourly ?? [], metric)
        : dailyComparison,
    [comparisonHourly, dailyComparison, snapshots, hourly, metric],
  );

  const tape = useMemo(() => lastWindow(hourly ?? [], 72, Date.now()), [hourly]);

  const profiles = useMemo(() => {
    const rows = hourly ?? [];
    return {
      floor: hourOfDayProfile(rows.map((r) => ({ at: r.capturedAt, value: r.minUsd }))),
      depth: hourOfDayProfile(rows.map((r) => ({ at: r.capturedAt, value: r.gpusAvailable }))),
      token: hourOfDayProfile(
        snapshots.map((s) => ({ at: s.capturedAt, value: s.usageWeightedPromptUsdPerMtok })),
      ),
    };
  }, [hourly, snapshots]);

  const profileHours = profiles.floor.filter((p) => p.samples > 0).length;

  const selectedMeta = accelerators?.find((a) => a.name === selected);

  if (error) return <ErrorNote error={error} />;
  if (!accelerators || !dailyAll || !priceIndex) return <Loading label="Loading compute market…" />;

  const tracked = accelerators.filter((a) => a.latest && a.latest.offers > 0);
  const totalGpus = tracked.reduce((sum, a) => sum + (a.latest?.gpusAvailable ?? 0), 0);
  const totalFenced = tracked.reduce((sum, a) => sum + (a.latest?.excludedOffers ?? 0), 0);
  const flagship = accelerators.find((a) => a.name === "B200")?.latest ?? null;

  // Each KPI reads its own series over its own window — tying them to the
  // token/GPU overlap would blank both until the two histories meet.
  const tokenChange = totalChangePct(priceIndex.slice(-30).map((p) => p.weightedUsdPerMtok));
  const gpuChange = totalChangePct(dailySelected.map((d) => d[metric]));

  return (
    <>
      <div className="view-head">
        <div>
          <div className="eyebrow">Cost side</div>
          <h2 className="section-title">What the silicon rents for</h2>
        </div>
        <p className="view-sub">
          Live GPU rental prices from the <b>vast.ai</b> marketplace, swept every 15 minutes and
          normalized to <b>USD per GPU-hour</b> (vast.ai quotes whole machines, so an 8×B200 box at
          $85/hr is $10.63/GPU-hr). Prices describe the <b>practical rentable market</b>: listings from
          deverified hosts and listings priced more than 3× away from the sweep median — parked asks
          nobody rents — are fenced out before any statistic is computed.
        </p>
      </div>

      <div className="grid kpis">
        <Kpi
          label="B200 practical floor"
          dot="cyan"
          value={gpuHr(flagship?.minUsd ?? null)}
          unit="/GPU-hr"
          sub={flagship ? `${flagship.offers} offers · ${flagship.gpusAvailable} GPUs live` : "no offers"}
        />
        <Kpi
          label="Accelerators tracked"
          value={tracked.length}
          sub={`${compact(totalGpus, 0)} GPUs on offer · ${totalFenced} junk listings fenced`}
        />
        <Kpi
          label="Token price, 30d"
          dot="gold"
          value={tokenChange === null ? "—" : `${tokenChange > 0 ? "+" : ""}${tokenChange.toFixed(1)}%`}
          sub="usage-weighted $/Mtok"
        />
        <Kpi
          label={`${selectedMeta?.label ?? selected} rental trend`}
          dot="violet"
          value={gpuChange === null ? "—" : `${gpuChange > 0 ? "+" : ""}${gpuChange.toFixed(1)}%`}
          sub={metric === "minUsd" ? "practical floor · since tracking began" : "median offer · since tracking began"}
        />
      </div>

      {/* The trading day: raw sweeps + hour-of-day seasonality */}
      <div className="grid chart-grid">
        <Panel className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">Last 72 hours — {selectedMeta?.label ?? selected}</div>
              <div className="chart-note mono">every sweep · price left, supply depth right · UTC</div>
            </div>
          </div>
          {hourly === null ? (
            <div className="empty">Loading sweeps…</div>
          ) : tape.length >= 6 ? (
            <IntradayTapeChart rows={tape} height={300} />
          ) : (
            <div className="empty" style={{ padding: "40px 10px" }}>
              The tape draws from 15-minute sweeps — a readable window builds up within hours.
            </div>
          )}
        </Panel>
        <Panel className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">The shape of a day</div>
              <div className="chart-note mono">median per UTC hour · 100 = typical hour · 14d window</div>
            </div>
          </div>
          {profileHours >= 6 ? (
            <>
              <HourProfileChart
                series={[
                  { name: `${selectedMeta?.label ?? selected} floor`, color: C.min, profile: profiles.floor },
                  { name: "GPUs on offer", color: DEPTH_AXIS, dash: "dot", profile: profiles.depth },
                  { name: "Token price (weighted)", color: C.amber, profile: profiles.token },
                ]}
                height={300}
              />
              <div className="inline-note">
                Reads as "percent of a typical hour". A floor dipping below 100 overnight (UTC) with
                depth above 100 is the market breathing: machines idle, supply pools, price sags —
                and the reverse during US/EU working hours. Token prices barely move intraday; that
                flatness against a breathing GPU line is itself the finding.
              </div>
            </>
          ) : (
            <div className="empty" style={{ padding: "40px 10px" }}>
              Hour-of-day profiles need sweeps across at least a few different hours — they sharpen
              over the first day and settle after a week.
            </div>
          )}
        </Panel>
      </div>

      {/* Trend comparison — the reason this view exists */}
      <Panel className="chart-card">
        <div className="chart-head">
          <div>
            <div className="chart-title">Inference price vs. raw compute</div>
            <div className="chart-note mono">
              {comparisonHourly
                ? `hourly · both rebased to 100 at window start · ${comparison.dates.length} shared hours · daily takes over after ${DAILY_MIN_DAYS} days`
                : `daily close · both rebased to 100 at window start · ${comparison.dates.length} shared days`}
            </div>
          </div>
          <div className="seg seg-sm">
            <button className={metric === "medianUsd" ? "active" : ""} onClick={() => setMetric("medianUsd")}>
              Median offer
            </button>
            <button className={metric === "minUsd" ? "active" : ""} onClick={() => setMetric("minUsd")}>
              Floor
            </button>
          </div>
        </div>
        {comparison.dates.length > 1 ? (
          <>
            <ComputeVsTokensChart
              dates={comparison.dates}
              tokenIndex={comparison.tokenIndex}
              gpuIndex={comparison.gpuIndex}
              tokenRaw={comparison.tokenRaw}
              gpuRaw={comparison.gpuRaw}
              gpuLabel={selectedMeta?.label ?? selected}
              height={320}
            />
            <div className="inline-note">
              The two series are in different units and never convert into one another — what is
              comparable is the <b>slope</b>. A token line falling faster than the compute line means
              inference is cheapening beyond what silicon rental explains (better utilization,
              competition, or margin compression); the reverse means providers are absorbing a rising
              cost floor.
            </div>
          </>
        ) : (
          <div className="empty">
            Overlap accumulates as GPU sweeps build up alongside hourly token snapshots — a
            readable window forms within a few hours.
          </div>
        )}
      </Panel>

      {/* Per-accelerator price history — sweep-level until dailies have depth */}
      <Panel className="chart-card">
        <div className="chart-head">
          <div>
            <div className="chart-title">{selectedMeta?.label ?? selected} rental price</div>
            <div className="chart-note mono">
              {selectedMeta ? `${selectedMeta.vramGb}GB · ${TIER_LABEL[selectedMeta.tier] ?? selectedMeta.tier}` : ""}
              {bandHourly
                ? ` · every 15-min sweep (${bandPoints.length}) · daily bands take over after ${DAILY_MIN_DAYS} days of history`
                : dailySelected.length
                  ? ` · ${dailySelected.length} days · daily aggregate of all sweeps`
                  : ""}
            </div>
          </div>
        </div>
        {bandPoints.length > 1 ? (
          <>
            <GpuBandChart points={bandPoints} height={340} />
            <div className="inline-note">
              The main line is the <b>25th-percentile ask</b> — in a 40-offer book, offer #10. The
              single cheapest box is often one lucky host and gets rented away in minutes; a quarter
              into the book is the price you can still get an hour later. The band spans cheapest →
              median, and the orange bars are GPUs on offer — price moves read against supply.
            </div>
          </>
        ) : (
          <div className="empty">
            Only {bandPoints.length} sweep of history so far — the series fills in from first ingest.
          </div>
        )}
      </Panel>

      {/* The board */}
      <Panel className="chart-card">
        <div className="chart-head">
          <div>
            <div className="chart-title">The accelerator board</div>
            <div className="chart-note mono">latest sweep · click a row to chart it · USD per GPU-hour</div>
          </div>
        </div>
        <div className="table-wrap">
          <table className="tt">
            <thead>
              <tr>
                <th className="left">Accelerator</th>
                <th>VRAM</th>
                <th>Floor $/GPU-hr</th>
                <th>Verified floor</th>
                <th>Median</th>
                <th>Middle 50%</th>
                <th>Spot floor</th>
                <th>Offers</th>
                <th>GPUs</th>
                <th>Trend</th>
              </tr>
            </thead>
            <tbody>
              {[...accelerators]
                .sort((a, b) => {
                  const tier = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
                  if (tier !== 0) return tier;
                  return (b.latest?.medianUsd ?? 0) - (a.latest?.medianUsd ?? 0);
                })
                .map((a) => {
                  const l = a.latest;
                  const spark = (dailyByGpu.get(a.name) ?? []).map((d) => d.medianUsd);
                  const change = totalChangePct(spark);
                  return (
                    <tr
                      key={a.name}
                      className={a.name === selected ? "row-sel" : ""}
                      onClick={() => setSelected(a.name)}
                    >
                      <td className="left">
                        <div className="model-cell">
                          <span className="model-name">{a.label}</span>
                          <span className="model-id">{TIER_LABEL[a.tier] ?? a.tier}</span>
                        </div>
                      </td>
                      <td>{a.vramGb}GB</td>
                      <td className="val-min">{gpuHr(l?.minUsd)}</td>
                      <td>{gpuHr(l?.verifiedMinUsd)}</td>
                      <td>{gpuHr(l?.medianUsd)}</td>
                      <td>
                        {l?.p25Usd != null && l?.p75Usd != null ? `${gpuHr(l.p25Usd)}–${gpuHr(l.p75Usd)}` : "—"}
                      </td>
                      <td>{gpuHr(l?.minBidUsd)}</td>
                      <td>{l?.offers ?? "—"}</td>
                      <td>{l ? compact(l.gpusAvailable, 0) : "—"}</td>
                      <td>
                        {spark.filter((v) => v !== null).length > 1 ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                            {/* Sparkline renders at width:100%, so it needs a sized box
                                or it would swallow the row and shove the delta off. */}
                            <div style={{ width: 70, flex: "0 0 70px" }}>
                              <Sparkline values={spark} color={C.indigo} width={70} height={22} />
                            </div>
                            <Delta value={change === null ? null : change / 100} invert />
                          </div>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <div className="inline-note">
          Prices are per GPU-hour for <b>on-demand, rentable</b> offers inside the practical-price
          fence: deverified hosts and listings priced beyond 3× either side of the sweep median are
          excluded from every figure, including depth. "Verified floor" is the cheapest offer from a
          host vast.ai has verified — the safe-path price. "Spot floor" is the cheapest interruptible
          bid — real but pre-emptible, and hosts deliberately set these near zero to fill idle time.
        </div>
      </Panel>
    </>
  );
}
