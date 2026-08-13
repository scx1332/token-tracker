import { useEffect, useMemo, useState } from "react";
import { api, type AcceleratorWithLatest, type GpuPriceRow, type PriceIndexPoint } from "../api";
import { Loading, ErrorNote, Panel, Delta, Kpi } from "../components";
import { GpuBandChart, ComputeVsTokensChart, Sparkline, C } from "../charts";
import { compact } from "../format";
import { toDailyPoints, groupByGpu, buildComparison, totalChangePct } from "../gpu";

const TIER_LABEL: Record<string, string> = {
  flagship: "Flagship",
  datacenter: "Datacenter",
  prosumer: "Prosumer",
};

const TIER_ORDER = ["flagship", "datacenter", "prosumer"];

/** $/GPU-hour to 3dp — rentals span $0.06 to $10, so a fixed 3 reads cleanly. */
function gpuHr(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `$${v.toFixed(3)}`;
}

export function ComputeView({ navigate: _navigate }: { navigate: (to: string) => void }) {
  const [accelerators, setAccelerators] = useState<AcceleratorWithLatest[] | null>(null);
  const [series, setSeries] = useState<GpuPriceRow[] | null>(null);
  const [priceIndex, setPriceIndex] = useState<PriceIndexPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("B200");
  const [metric, setMetric] = useState<"minUsd" | "medianUsd">("medianUsd");

  useEffect(() => {
    let alive = true;
    Promise.all([api.gpu(), api.gpuSeries({ days: 30 }), api.market(120)])
      .then(([g, s, m]) => {
        if (!alive) return;
        setAccelerators(g.accelerators);
        setSeries(s.series);
        setPriceIndex(m.priceIndex);
      })
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  const byGpu = useMemo(() => groupByGpu(series ?? []), [series]);

  const dailyBySelected = useMemo(
    () => toDailyPoints(byGpu.get(selected) ?? []),
    [byGpu, selected],
  );

  const comparison = useMemo(
    () => buildComparison(priceIndex ?? [], dailyBySelected, metric),
    [priceIndex, dailyBySelected, metric],
  );

  const selectedMeta = accelerators?.find((a) => a.name === selected);

  if (error) return <ErrorNote error={error} />;
  if (!accelerators || !series || !priceIndex) return <Loading label="Loading compute market…" />;

  const tracked = accelerators.filter((a) => a.latest && a.latest.offers > 0);
  const totalGpus = tracked.reduce((sum, a) => sum + (a.latest?.gpusAvailable ?? 0), 0);
  const flagship = accelerators.find((a) => a.name === "B200")?.latest ?? null;

  const tokenChange = totalChangePct(comparison.tokenRaw);
  const gpuChange = totalChangePct(comparison.gpuRaw);

  return (
    <>
      <div className="view-head">
        <div>
          <div className="eyebrow">Cost side</div>
          <h2 className="section-title">What the silicon rents for</h2>
        </div>
        <p className="view-sub">
          Live GPU rental prices from the <b>vast.ai</b> marketplace, normalized to <b>USD per GPU-hour</b>{" "}
          (vast.ai quotes whole machines, so an 8×B200 box at $85/hr is $10.63/GPU-hr). Every tracked
          accelerator's full offer book is swept hourly; the band is the middle 50% of live offers.
        </p>
      </div>

      <div className="grid kpis">
        <Kpi
          label="B200 cheapest"
          dot="cyan"
          value={gpuHr(flagship?.minUsd ?? null)}
          unit="/GPU-hr"
          sub={flagship ? `${flagship.offers} offers · ${flagship.gpusAvailable} GPUs live` : "no offers"}
        />
        <Kpi
          label="Accelerators tracked"
          value={tracked.length}
          sub={`${accelerators.length} in catalog · ${compact(totalGpus, 0)} GPUs on offer`}
        />
        <Kpi
          label="Token price, window"
          dot="gold"
          value={tokenChange === null ? "—" : `${tokenChange > 0 ? "+" : ""}${tokenChange.toFixed(1)}%`}
          sub="usage-weighted $/Mtok"
        />
        <Kpi
          label={`${selectedMeta?.label ?? selected} rental, window`}
          dot="violet"
          value={gpuChange === null ? "—" : `${gpuChange > 0 ? "+" : ""}${gpuChange.toFixed(1)}%`}
          sub={metric === "minUsd" ? "cheapest offer" : "median offer"}
        />
      </div>

      {/* Trend comparison — the reason this view exists */}
      <Panel className="chart-card">
        <div className="chart-head">
          <div>
            <div className="chart-title">Inference price vs. raw compute</div>
            <div className="chart-note mono">
              both rebased to 100 at window start · {comparison.dates.length} shared days
            </div>
          </div>
          <div className="seg seg-sm">
            <button className={metric === "medianUsd" ? "active" : ""} onClick={() => setMetric("medianUsd")}>
              Median offer
            </button>
            <button className={metric === "minUsd" ? "active" : ""} onClick={() => setMetric("minUsd")}>
              Cheapest
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
              The two series are in different units and never convert into one another — what is comparable
              is the <b>slope</b>. A token line falling faster than the compute line means inference is
              cheapening beyond what silicon rental explains (better utilization, competition, or margin
              compression); the reverse means providers are absorbing a rising cost floor.
            </div>
          </>
        ) : (
          <div className="empty">
            Overlap accumulates as GPU snapshots build up alongside the token index — check back tomorrow.
          </div>
        )}
      </Panel>

      {/* Per-accelerator price history */}
      <Panel className="chart-card">
        <div className="chart-head">
          <div>
            <div className="chart-title">{selectedMeta?.label ?? selected} rental price</div>
            <div className="chart-note mono">
              {selectedMeta ? `${selectedMeta.vramGb}GB · ${TIER_LABEL[selectedMeta.tier] ?? selectedMeta.tier}` : ""}
              {dailyBySelected.length ? ` · ${dailyBySelected.length} days` : ""}
            </div>
          </div>
        </div>
        {dailyBySelected.length > 1 ? (
          <GpuBandChart points={dailyBySelected} height={340} />
        ) : (
          <div className="empty">
            Only {dailyBySelected.length} day of history so far — the series fills in hourly from first ingest.
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
                <th>Cheapest $/GPU-hr</th>
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
                  const daily = toDailyPoints(byGpu.get(a.name) ?? []);
                  const spark = daily.map((d) => d.medianUsd);
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
          Prices are per GPU-hour for <b>on-demand, rentable</b> offers. "Spot floor" is the cheapest
          interruptible bid — real but pre-emptible. Min and max reflect individual listings and can be
          outliers (a mispriced card sits in the book like any other), which is why the median and the
          middle-50% band carry the trend rather than the extremes.
        </div>
      </Panel>
    </>
  );
}
