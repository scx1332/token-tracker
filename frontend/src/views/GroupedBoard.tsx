import { useEffect, useState } from "react";
import { api, type RacePoint, type TopModel } from "../api";
import { Panel, Loading, type RankItem } from "../components";
import { ProviderRevenueChart, PROVIDER_COLORS, escapeHtml, C } from "../charts";
import { usd, compact, displayName } from "../format";
import { breakdownAt, familySeries, groupByFamily, type Grouping } from "../family";
import { encodeModelId } from "../routes";
import { RACE_PINS, RACE_SINCE } from "./RacePanel";

/**
 * The latest-day leaderboard summed by a grouping: one row per group, its
 * count of models in the name, its split as a native tooltip, and a link to
 * its biggest member — a grouped row has no page of its own.
 */
export function groupedRankItems(
  topModels: TopModel[],
  grouping: Grouping,
  by: "spend" | "tokens" = "spend",
  limit = 15,
): RankItem[] {
  const groups = groupByFamily(
    topModels.map((m) => ({ ...m, name: displayName(m.name) })),
    grouping,
  );
  const metric = (g: { spendUsd: number; tokens: number }) => (by === "spend" ? g.spendUsd : g.tokens);
  const fmt = (v: number) => (by === "spend" ? usd(v) : `${compact(v)} tok`);
  if (by === "tokens") groups.sort((a, b) => b.tokens - a.tokens || b.spendUsd - a.spendUsd);
  const max = groups[0] ? metric(groups[0]) : 1;
  return groups.slice(0, limit).map((g) => ({
    // A group always says how many models it holds — "1 model" included, so a
    // family of one reads the same as a family of five.
    name: g.grouped ? `${g.label} · ${g.members.length} model${g.members.length === 1 ? "" : "s"}` : g.label,
    value: metric(g),
    valueLabel: by === "spend" ? `${usd(g.spendUsd)} · ${compact(g.tokens)} tok` : `${compact(g.tokens)} tok · ${usd(g.spendUsd)}`,
    ...(g.grouped
      ? {
          title: [...g.parts]
            .sort((a, b) => metric(b) - metric(a))
            .map((p) => `${p.label} — ${fmt(metric(p))} (${((metric(p) / (metric(g) || 1)) * 100).toFixed(0)}%)`)
            .join("\n"),
        }
      : {}),
    frac: metric(g) / (max || 1),
    href: `/model/${encodeModelId(g.members[0]!.modelId)}`,
    color: by === "spend" ? C.gold : C.cyan,
  }));
}

/**
 * The same groups over time, stacked. Weeks come free with /market (full ISO
 * weeks only); days are fetched on demand — the exact request the race panel
 * makes, so the two share one browser cache entry — and carry a running day,
 * which the chart shades. Either way the window starts where the race does.
 */
export function GroupedStackPanel({
  weeklyPoints,
  includeFree,
  grouping,
  title = "Model families over time",
  rowsNote = "versions of one line summed",
  topN = 8,
  height = 320,
}: {
  weeklyPoints: RacePoint[];
  includeFree: boolean;
  grouping: Grouping;
  title?: string;
  rowsNote?: string;
  topN?: number;
  height?: number;
}) {
  // Dollars lead for the same reason the leaderboard's do.
  const [mode, setMode] = useState<"spend" | "tokens">("spend");
  // Days lead: with versions summed into one band per line, the daily grain is
  // legible — and it puts a launch or a routing switch on its own date.
  const [bucket, setBucket] = useState<"day" | "week">("day");
  const [dayRace, setDayRace] = useState<RacePoint[] | null>(null);

  useEffect(() => {
    if (bucket !== "day") return;
    let alive = true;
    setDayRace(null);
    api
      .race({ bucket: "day", top: 50, pin: RACE_PINS, includeFree })
      .then((r) => alive && setDayRace(r.points))
      // The weekly points are already on the page — fall back to them rather
      // than blanking the panel.
      .catch(() => alive && setBucket("week"));
    return () => {
      alive = false;
    };
  }, [bucket, includeFree]);

  const loading = bucket === "day" && dayRace === null;
  const points = (bucket === "day" ? dayRace ?? [] : weeklyPoints).filter((p) => p.date >= RACE_SINCE);
  const stack = familySeries(points, mode, topN, grouping);
  const fmt = (v: number) => (mode === "spend" ? usd(v) : `${compact(v)} tok`);
  const traces = stack.series.map((s, i) => ({
    name: s.label,
    x: stack.dates,
    y: s.values as (number | null)[],
    color: s.key === "__others" ? C.faint : PROVIDER_COLORS[i % PROVIDER_COLORS.length]!,
    // What that band is made of on that date, each part with its share of the
    // band — the whole point of summing is being able to unfold the sum.
    hover: stack.dates.map((_, di) => {
      const lines = breakdownAt(s, di, fmt);
      return lines.length ? `<br>${lines.map((l) => escapeHtml(l)).join("<br>")}` : "";
    }),
  }));

  return (
    <Panel className="chart-card">
      <div className="chart-head">
        <div>
          <div className="chart-title">{title}</div>
          <div className="chart-note">
            stacked {mode === "spend" ? "est. spend" : "tokens"} per {bucket} · {rowsNote} · top {topN}, the rest pooled
            {bucket === "day" ? " · the shaded tail is today, still counting" : " · full weeks only"}
          </div>
        </div>
        <div className="seg-row">
          <div className="seg seg-sm">
            <button className={mode === "spend" ? "active" : ""} onClick={() => setMode("spend")}>
              Est. spend
            </button>
            <button className={mode === "tokens" ? "active" : ""} onClick={() => setMode("tokens")}>
              Tokens
            </button>
          </div>
          <div className="seg seg-sm">
            <button
              className={bucket === "day" ? "active" : ""}
              onClick={() => setBucket("day")}
              title="One band per day — where a launch or a price cut actually lands"
            >
              Daily
            </button>
            <button
              className={bucket === "week" ? "active" : ""}
              onClick={() => setBucket("week")}
              title="Full ISO weeks — the trend, with weekday noise summed out"
            >
              Weekly
            </button>
          </div>
        </div>
      </div>
      {loading ? (
        // Hold the plot's height so switching grain doesn't bounce the row.
        <div style={{ height, display: "grid", placeItems: "center" }}>
          <Loading label="Loading daily history…" />
        </div>
      ) : traces.length && stack.dates.length > 1 ? (
        <ProviderRevenueChart traces={traces} mode={mode} height={height} />
      ) : (
        <div className="empty" style={{ padding: "40px 10px" }}>
          Not enough {bucket === "day" ? "daily" : "weekly"} history yet.
        </div>
      )}
    </Panel>
  );
}
