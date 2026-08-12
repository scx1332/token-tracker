import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-dist-min";
import type { Layout, Config, Data } from "plotly.js-dist-min";
import { useMemo } from "react";
import type { MarketRow, PriceHistoryRow, UsageRow, UsageSeriesPoint } from "./api";

export const Plot = createPlotlyComponent(Plotly);

export const C = {
  gold: "#f6b44a",
  cyan: "#3fd8e6",
  violet: "#8b7bf6",
  up: "#3ddc97",
  down: "#ff6b7d",
  text: "#e9f0fb",
  muted: "#8ea0bd",
  faint: "#5c6c8a",
  grid: "#172234",
  panel: "#0e1626",
  line: "#1f2c46",
};

const FONT = "IBM Plex Mono, ui-monospace, monospace";

const baseConfig: Partial<Config> = { displayModeBar: false, responsive: true };

function baseLayout(overrides: Partial<Layout> = {}): Partial<Layout> {
  return {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: FONT, color: C.muted, size: 11 },
    margin: { l: 52, r: 16, t: 10, b: 34 },
    hovermode: "x unified",
    hoverlabel: {
      bgcolor: "#0b1220",
      bordercolor: C.line,
      font: { family: FONT, color: C.text, size: 12 },
    },
    showlegend: false,
    xaxis: {
      gridcolor: C.grid,
      zerolinecolor: C.grid,
      linecolor: C.line,
      tickfont: { family: FONT, color: C.faint, size: 10 },
      showgrid: false,
      ...(overrides.xaxis ?? {}),
    },
    yaxis: {
      gridcolor: C.grid,
      zeroline: false,
      tickfont: { family: FONT, color: C.faint, size: 10 },
      ...(overrides.yaxis ?? {}),
    },
    ...overrides,
  };
}

function xdates(rows: { bucketDate?: string; observedAt?: string; date?: string }[], key: "bucketDate" | "observedAt" | "date"): string[] {
  return rows.map((r) => (r as Record<string, string>)[key]);
}

/** Hero chart: estimated daily spend (gold area) + daily tokens (cyan line, 2nd axis). */
export function SpendTokensChart({ series, height = 300 }: { series: UsageSeriesPoint[]; height?: number }) {
  const data = useMemo<Data[]>(() => {
    const x = xdates(series, "bucketDate");
    return [
      {
        type: "scatter",
        mode: "lines",
        name: "Est. spend",
        x,
        y: series.map((s) => s.totalSpendUsd),
        line: { color: C.gold, width: 2.4, shape: "spline", smoothing: 0.6 },
        fill: "tozeroy",
        fillcolor: "rgba(246,180,74,0.10)",
        yaxis: "y",
        hovertemplate: "$%{y:,.0f}<extra>spend</extra>",
      },
      {
        type: "scatter",
        mode: "lines",
        name: "Tokens",
        x,
        y: series.map((s) => s.totalTokens),
        line: { color: C.cyan, width: 1.8, shape: "spline", smoothing: 0.6 },
        yaxis: "y2",
        hovertemplate: "%{y:.3s} tok<extra>tokens</extra>",
      },
    ];
  }, [series]);

  const layout = baseLayout({
    height,
    margin: { l: 58, r: 54, t: 10, b: 34 },
    yaxis: { gridcolor: C.grid, showgrid: true, zeroline: false, tickfont: { family: FONT, color: C.gold, size: 10 }, tickprefix: "$", tickformat: ".2s" },
    yaxis2: { overlaying: "y", side: "right", showgrid: false, zeroline: false, tickfont: { family: FONT, color: C.cyan, size: 10 }, tickformat: ".2s" },
  });

  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

/** Price index over time: usage-weighted + median $/Mtok from market snapshots. */
export function PriceIndexChart({ snapshots, height = 260 }: { snapshots: MarketRow[]; height?: number }) {
  const data = useMemo<Data[]>(() => {
    const x = snapshots.map((s) => s.capturedAt);
    return [
      {
        type: "scatter",
        mode: "lines",
        name: "Usage-weighted",
        x,
        y: snapshots.map((s) => s.usageWeightedPromptUsdPerMtok),
        line: { color: C.gold, width: 2.4 },
        hovertemplate: "$%{y:.3f}<extra>weighted</extra>",
      },
      {
        type: "scatter",
        mode: "lines",
        name: "Median",
        x,
        y: snapshots.map((s) => s.medianPromptUsdPerMtok),
        line: { color: C.violet, width: 1.6, dash: "dot" },
        hovertemplate: "$%{y:.3f}<extra>median</extra>",
      },
    ];
  }, [snapshots]);

  const layout = baseLayout({ height, yaxis: { gridcolor: C.grid, showgrid: true, zeroline: false, tickprefix: "$", tickfont: { family: FONT, color: C.faint, size: 10 } } });
  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

/** Model price history: prompt + completion $/Mtok (model-level). */
export function PriceHistoryChart({ rows, height = 300 }: { rows: PriceHistoryRow[]; height?: number }) {
  const data = useMemo<Data[]>(() => {
    const x = xdates(rows, "observedAt");
    const toMtok = (v: number | null) => (v === null ? null : v * 1_000_000);
    return [
      {
        type: "scatter",
        mode: "lines",
        name: "Input",
        x,
        y: rows.map((r) => toMtok(r.promptUsd)),
        line: { color: C.cyan, width: 2.4, shape: "hv" },
        hovertemplate: "$%{y:.3f}/M<extra>input</extra>",
      },
      {
        type: "scatter",
        mode: "lines",
        name: "Output",
        x,
        y: rows.map((r) => toMtok(r.completionUsd)),
        line: { color: C.gold, width: 2.4, shape: "hv" },
        hovertemplate: "$%{y:.3f}/M<extra>output</extra>",
      },
    ];
  }, [rows]);

  const layout = baseLayout({ height, yaxis: { gridcolor: C.grid, showgrid: true, zeroline: false, tickprefix: "$", tickfont: { family: FONT, color: C.faint, size: 10 } } });
  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

/** Model usage history: daily tokens (cyan area) + estimated spend (gold line, 2nd axis). */
export function UsageHistoryChart({ rows, height = 300 }: { rows: UsageRow[]; height?: number }) {
  const data = useMemo<Data[]>(() => {
    const x = xdates(rows, "bucketDate");
    return [
      {
        type: "scatter",
        mode: "lines",
        name: "Tokens",
        x,
        y: rows.map((r) => r.tokens),
        line: { color: C.cyan, width: 2.2, shape: "spline", smoothing: 0.5 },
        fill: "tozeroy",
        fillcolor: "rgba(63,216,230,0.10)",
        hovertemplate: "%{y:.3s} tok<extra>tokens</extra>",
      },
      {
        type: "scatter",
        mode: "lines",
        name: "Est. spend",
        x,
        y: rows.map((r) => r.estimatedSpendUsd),
        line: { color: C.gold, width: 1.8 },
        yaxis: "y2",
        hovertemplate: "$%{y:,.0f}<extra>spend</extra>",
      },
    ];
  }, [rows]);

  const layout = baseLayout({
    height,
    margin: { l: 54, r: 54, t: 10, b: 34 },
    yaxis: { gridcolor: C.grid, showgrid: true, zeroline: false, tickformat: ".2s", tickfont: { family: FONT, color: C.cyan, size: 10 } },
    yaxis2: { overlaying: "y", side: "right", showgrid: false, zeroline: false, tickprefix: "$", tickformat: ".2s", tickfont: { family: FONT, color: C.gold, size: 10 } },
  });
  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

const RACE_COLORS = [C.gold, C.cyan, C.violet, C.up, "#f57bb0", "#7fb0ff", "#e6c86b", "#66d9c2"];

/** 1-year weekly token throughput for the top models (the "model race"). */
export function WeeklyRaceChart({
  points,
  height = 300,
  topN = 8,
}: {
  points: { date: string; tokensByPermaslug: Record<string, number> }[];
  height?: number;
  topN?: number;
}) {
  const { data } = useMemo(() => {
    const totals = new Map<string, number>();
    for (const p of points) {
      for (const [k, v] of Object.entries(p.tokensByPermaslug ?? {})) {
        totals.set(k, (totals.get(k) ?? 0) + (Number(v) || 0));
      }
    }
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k]) => k);
    const x = points.map((p) => p.date);
    const traces: Data[] = top.map((slug, i) => ({
      type: "scatter",
      mode: "lines",
      name: shortSlug(slug),
      x,
      y: points.map((p) => p.tokensByPermaslug?.[slug] ?? null),
      line: { color: RACE_COLORS[i % RACE_COLORS.length], width: 1.9, shape: "spline", smoothing: 0.5 },
      hovertemplate: `${shortSlug(slug)}: %{y:.3s}<extra></extra>`,
    }));
    return { data: traces };
  }, [points, topN]);

  const layout = baseLayout({
    height,
    hovermode: "closest",
    margin: { l: 48, r: 12, t: 10, b: 34 },
    yaxis: { gridcolor: C.grid, showgrid: true, zeroline: false, tickformat: ".2s", tickfont: { family: FONT, color: C.faint, size: 10 } },
  });
  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

function shortSlug(slug: string): string {
  const base = slug.split("/").pop() ?? slug;
  return base.replace(/-\d{6,8}$/, "").slice(0, 22);
}

/** Tiny inline SVG sparkline (no Plotly) for KPI cards. */
export function Sparkline({
  values,
  color = C.cyan,
  width = 240,
  height = 34,
  fill = true,
}: {
  values: (number | null)[];
  color?: string;
  width?: number;
  height?: number;
  fill?: boolean;
}) {
  const nums = values.map((v) => (v === null || !Number.isFinite(v as number) ? null : (v as number)));
  const present = nums.filter((v): v is number => v !== null);
  if (present.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...present);
  const max = Math.max(...present);
  const range = max - min || 1;
  const n = nums.length;
  const pts: [number, number][] = [];
  nums.forEach((v, i) => {
    if (v === null) return;
    const x = (i / (n - 1)) * width;
    const y = height - 3 - ((v - min) / range) * (height - 6);
    pts.push([x, y]);
  });
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${d} L${pts[pts.length - 1]![0].toFixed(1)},${height} L${pts[0]![0].toFixed(1)},${height} Z`;
  const gid = `sg-${Math.round(width)}-${color.replace("#", "")}`;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${gid})`} />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
