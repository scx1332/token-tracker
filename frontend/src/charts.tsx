import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-dist-min";
import type { Layout, Config, Data } from "plotly.js-dist-min";
import { useMemo } from "react";
import type { PriceHistoryRow, UsageRow, UsageSeriesPoint } from "./api";
import type { WeekBucket, WeekDayCell } from "./weekly";
import { isClosedDay } from "./runningDay";

export const Plot = createPlotlyComponent(Plotly);

// Light, print-legible data palette. Neutrals carry the page; color only ever
// encodes meaning: teal = tokens/volume, amber = dollars/spend, indigo = price
// (and the minimum-price line is the strongest blue on the page).
export const C = {
  ink: "#111722",
  text: "#111722",
  muted: "#586576",
  faint: "#8b97a6",
  tick: "#39434f", // axis tick labels — darker than muted, softer than ink
  line: "#e2e7ee",
  grid: "#eef1f6",
  panel: "#ffffff",
  paper: "#f4f6f9",

  teal: "#0e7c86", // tokens / volume
  amber: "#b06a06", // dollars / spend
  indigo: "#3b3fc4", // secondary price
  min: "#2b34cc", // minimum price — the hero series
  up: "#137a45",
  down: "#c23b3b",

  // aliases kept so existing views keep working under the new palette
  cyan: "#0e7c86",
  gold: "#b06a06",
  violet: "#6a54c8",
};

// GPU supply depth ("GPUs on offer"): a semi-transparent orange step AREA with
// a solid top edge, never bars — at 15-min sweep density a bar is ~1px wide on
// a time axis and disappears no matter how saturated it is. The edge line keeps
// depth legible even where the fill sits behind the price band.
const DEPTH_FILL = "rgba(232, 119, 34, 0.10)";
/** Matching solid orange for the depth edge, axis ticks/titles and line series. */
export const DEPTH_AXIS = "#c4650f";

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

// Distinct hues for compared provider lines (indigo is reserved for the
// minimum-price hero line). Index = order the provider was selected in.
export const PROVIDER_COLORS = [
  "#0e7c86", // teal
  "#b06a06", // amber
  "#6a54c8", // violet
  "#137a45", // green
  "#c23b3b", // red
  "#8c3f9e", // purple
  "#3f6fb5", // steel blue
  "#7a5d1e", // olive
];

const baseConfig: Partial<Config> = { displayModeBar: false, responsive: true };

const AXIS_SPIKE = {
  showspikes: true,
  spikecolor: "#9aa6b5",
  spikethickness: 1,
  spikedash: "dot" as const,
  spikemode: "across" as const,
};

function baseLayout(overrides: Partial<Layout> = {}): Partial<Layout> {
  const { xaxis, yaxis, ...rest } = overrides;
  return {
    paper_bgcolor: "#ffffff",
    plot_bgcolor: "#ffffff",
    font: { family: FONT, color: C.muted, size: 11 },
    margin: { l: 56, r: 16, t: 12, b: 34 },
    hovermode: "x unified",
    hoverlabel: {
      bgcolor: "#ffffff",
      bordercolor: C.line,
      font: { family: FONT, color: C.ink, size: 12 },
    },
    showlegend: false,
    colorway: [C.teal, C.amber, C.indigo, C.up, C.down, C.violet],
    xaxis: {
      gridcolor: C.grid,
      linecolor: C.line,
      zeroline: false,
      ticks: "outside",
      tickcolor: C.line,
      ticklen: 4,
      tickfont: { family: FONT, color: C.tick, size: 10 },
      showgrid: false,
      ...AXIS_SPIKE,
      ...(xaxis ?? {}),
    },
    yaxis: {
      gridcolor: C.grid,
      linecolor: C.line,
      zeroline: false,
      showgrid: true,
      tickfont: { family: FONT, color: C.tick, size: 10 },
      ...(yaxis ?? {}),
    },
    ...rest,
  };
}

function xdates(
  rows: { bucketDate?: string; observedAt?: string; date?: string }[],
  key: "bucketDate" | "observedAt" | "date",
): string[] {
  return rows.map((r) => (r as Record<string, string>)[key]);
}

// ---------------------------------------------------------------------------
// The day still filling
// ---------------------------------------------------------------------------
//
// Daily series are sums, so their newest bucket is short until the day ends
// (see runningDay.ts). It is shown rather than hidden — but a solid line
// running into a half-counted day reads as a collapse, so it gets its own
// treatment everywhere: the closed days keep the solid line, the day in
// progress hangs off the end as a dotted tail, and a shaded band behind it
// carries the label. Never a projection — this portal forecasts weeks, not days.

const RUNNING_FILL = "rgba(17,23,34,0.06)";
const RUNNING_LABEL = "still filling";

/** Index of the first point whose day has not ended, or -1 when all have. */
function runningIndex(dates: string[], nowMs: number): number {
  return dates.findIndex((d) => d && !isClosedDay(d, nowMs));
}

/**
 * The solid part: values up to the last closed day, then nulls. A series with
 * nothing but a running day in it (idx 0) is drawn plainly — there is no
 * closed day to hang a tail off, and one point draws no line either way.
 */
function untilRunning<T>(y: T[], idx: number): (T | null)[] {
  return idx < 1 ? y : y.map((v, i) => (i < idx ? v : null));
}

/**
 * The dotted part: the last closed day joined to the day in progress. Same
 * length and same x as the solid trace, nulls everywhere else — which is how
 * Plotly draws one line in two styles without duplicating the axis.
 */
function fromRunning<T>(y: T[], idx: number): (T | null)[] {
  return y.map((v, i) => (i === idx - 1 || i >= idx ? v : null));
}

/** Shaded band + label over the day in progress, for any date-axis chart. */
function runningDayMarks(dates: string[], idx: number): Partial<Layout> {
  if (idx < 1) return {};
  return {
    shapes: [
      {
        type: "rect",
        xref: "x",
        yref: "paper",
        x0: dates[idx - 1]!,
        x1: dates[dates.length - 1]!,
        y0: 0,
        y1: 1,
        fillcolor: RUNNING_FILL,
        line: { width: 0 },
        layer: "below",
      },
    ],
    // Set vertically inside the band. A horizontal label has nowhere to go: the
    // band is one day wide (~10px), the right edge is where the axis labels
    // live, above is either a tight margin or the legend, and any of those
    // clips it or lands it on top of the series it is describing.
    annotations: [
      {
        x: dates[dates.length - 1]!,
        xref: "x",
        xshift: -6,
        y: 0.5,
        yref: "paper",
        xanchor: "center",
        yanchor: "middle",
        textangle: "-90",
        text: RUNNING_LABEL,
        showarrow: false,
        font: { family: FONT, size: 9, color: C.muted },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Price Explorer — the signature charts
// ---------------------------------------------------------------------------

/**
 * A model's price history: the cheapest-provider line (bold, the "minimum"
 * analysts track) plus an own step line per shown provider — by default the
 * ones carrying real traffic, with anything else added by clicking. Prices are
 * step functions, so the lines use h-v interpolation; a rangeslider lets you
 * scrub the timeline.
 */
export function PriceEnvelopeChart({
  x,
  min,
  cheapest,
  providers,
  metricLabel,
  height = 400,
  rangeslider = true,
}: {
  x: string[];
  min: (number | null)[];
  cheapest: (string | null)[];
  providers?: { name: string; x: string[]; y: (number | null)[]; color: string }[];
  metricLabel: string;
  height?: number;
  rangeslider?: boolean;
}) {
  const data = useMemo<Data[]>(() => {
    const traces: Data[] = [];
    traces.push({
      type: "scatter",
      mode: "lines+markers",
      name: "Cheapest provider",
      x,
      y: min,
      line: { color: C.min, width: 2.4, shape: "hv" },
      marker: { size: 5, color: C.min },
      customdata: cheapest as unknown as string[],
      hovertemplate: "$%{y:.4~f}/M · %{customdata}<extra>min</extra>",
    });
    for (const p of providers ?? []) {
      traces.push({
        type: "scatter",
        mode: "lines+markers",
        name: p.name,
        x: p.x,
        y: p.y,
        line: { color: p.color, width: 2, shape: "hv", dash: "solid" },
        marker: { size: 5, color: p.color },
        hovertemplate: `$%{y:.4~f}/M<extra>${escapeHtml(p.name)}</extra>`,
      });
    }
    return traces;
  }, [x, min, cheapest, providers]);

  const layout = baseLayout({
    height,
    showlegend: true,
    // yanchor bottom: wrapped legend rows grow upward instead of covering the plot.
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { family: FONT, size: 11, color: C.muted } },
    margin: { l: 62, r: 18, t: 52, b: rangeslider ? 20 : 34 },
    yaxis: {
      gridcolor: C.grid,
      showgrid: true,
      zeroline: false,
      // Anchored at $0: a cropped axis turns a stable price into fake swings.
      rangemode: "tozero",
      tickprefix: "$",
      tickfont: { family: FONT, color: C.tick, size: 10 },
      title: { text: metricLabel, font: { family: FONT, size: 10, color: C.muted } },
    },
    xaxis: {
      gridcolor: C.grid,
      showgrid: false,
      ...AXIS_SPIKE,
      rangeslider: rangeslider ? { visible: true, thickness: 0.08, bgcolor: "#f4f6f9", bordercolor: C.line } : { visible: false },
      tickfont: { family: FONT, color: C.tick, size: 10 },
    },
  });

  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

/**
 * Current "order book": each provider's latest quote for one model, cheapest at
 * the top. Click a bar to pin that provider on the envelope chart.
 */
export function ProviderOrderBookChart({
  quotes,
  height,
  onPick,
  selected,
  kind = "price",
}: {
  quotes: { provider: string; value: number | null }[];
  height?: number;
  onPick?: (provider: string) => void;
  selected?: string[];
  /** price = $/Mtok quotes (cheapest first) · tokens/spend = est. daily volume (biggest first). */
  kind?: "price" | "tokens" | "spend";
}) {
  const priced = quotes.filter((q) => q.value != null && Number.isFinite(q.value));
  // Cheapest at top: Plotly stacks the first category at the bottom, so reverse.
  const ordered = [...priced].reverse();
  const h = height ?? Math.max(140, ordered.length * 26 + 46);
  const isMoney = kind !== "tokens";
  const fmt = (v: number) => (kind === "price" ? `$${fmtPrice(v)}` : isMoney ? `$${fmtCompact(v)}` : fmtCompact(v));

  const data = useMemo<Data[]>(() => {
    const y = ordered.map((q) => q.provider);
    const xv = ordered.map((q) => q.value as number);
    const leader = priced[0]?.provider;
    // Pinned providers wear the same hue as their line on the envelope chart.
    const colors = ordered.map((q) => {
      const idx = selected?.indexOf(q.provider) ?? -1;
      if (idx >= 0) return PROVIDER_COLORS[idx % PROVIDER_COLORS.length]!;
      if (kind === "price") return q.provider === leader ? C.up : "rgba(176,106,6,0.72)";
      return kind === "tokens" ? "rgba(14,124,134,0.72)" : "rgba(176,106,6,0.72)";
    });
    return [
      {
        type: "bar",
        orientation: "h",
        x: xv,
        y,
        marker: { color: colors, line: { width: 0 } },
        text: xv.map(fmt),
        textposition: "auto",
        textfont: { family: FONT, size: 10, color: "#ffffff" },
        hovertemplate: kind === "price" ? "%{y}<br>$%{x:.4~f}/M<extra></extra>" : `%{y}<br>${isMoney ? "$" : ""}%{x:.3~s}/day<extra></extra>`,
      },
    ];
  }, [ordered, selected, kind]);

  const layout = baseLayout({
    height: h,
    margin: { l: 128, r: 18, t: 6, b: 28 },
    bargap: 0.32,
    xaxis: {
      gridcolor: C.grid,
      showgrid: true,
      zeroline: false,
      ...(isMoney ? { tickprefix: "$" } : {}),
      tickfont: { family: FONT, color: C.tick, size: 10 },
      ...AXIS_SPIKE,
    },
    yaxis: { showgrid: false, automargin: true, tickfont: { family: FONT, color: C.tick, size: 10.5 }, linecolor: C.line },
  });

  return (
    <Plot
      data={data}
      layout={layout}
      config={baseConfig}
      className="plot"
      style={{ width: "100%", height: h }}
      useResizeHandler
      onClick={(e: Readonly<Plotly.PlotMouseEvent>) => {
        const p = e?.points?.[0]?.y;
        if (p != null && onPick) onPick(String(p));
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Market + model charts (restyled to the light technical theme)
// ---------------------------------------------------------------------------

/** Estimated daily spend (amber area) + daily tokens (teal line, 2nd axis). */
export function SpendTokensChart({
  series,
  height = 300,
  nowMs = Date.now(),
}: {
  series: UsageSeriesPoint[];
  height?: number;
  nowMs?: number;
}) {
  const { data, marks } = useMemo(() => {
    const x = xdates(series, "bucketDate");
    const idx = runningIndex(x, nowMs);
    const spend = series.map((s) => s.totalSpendUsd);
    const tokens = series.map((s) => s.totalTokens);
    const out: Data[] = [
      {
        type: "scatter",
        mode: "lines",
        name: "Est. spend",
        x,
        y: untilRunning(spend, idx),
        line: { color: C.amber, width: 2 },
        fill: "tozeroy",
        fillcolor: "rgba(176,106,6,0.07)",
        yaxis: "y",
        hovertemplate: "$%{y:,.0f}<extra>spend</extra>",
      },
      {
        type: "scatter",
        mode: "lines",
        name: "Tokens",
        x,
        y: untilRunning(tokens, idx),
        line: { color: C.teal, width: 1.8 },
        yaxis: "y2",
        hovertemplate: "%{y:.3s} tok<extra>tokens</extra>",
      },
    ];
    // The day in progress: the same two series, dotted, so the last leg reads
    // as "counting" rather than as a fall.
    if (idx > 0) {
      out.push(
        {
          type: "scatter",
          mode: "lines",
          name: "Est. spend (today)",
          x,
          y: fromRunning(spend, idx),
          line: { color: C.amber, width: 2, dash: "dot" },
          fill: "tozeroy",
          fillcolor: "rgba(176,106,6,0.035)",
          yaxis: "y",
          hovertemplate: "$%{y:,.0f}<extra>spend so far today</extra>",
        },
        {
          type: "scatter",
          mode: "lines",
          name: "Tokens (today)",
          x,
          y: fromRunning(tokens, idx),
          line: { color: C.teal, width: 1.8, dash: "dot" },
          yaxis: "y2",
          hovertemplate: "%{y:.3s} tok<extra>tokens so far today</extra>",
        },
      );
    }
    return { data: out, marks: runningDayMarks(x, idx) };
  }, [series, nowMs]);

  const layout = baseLayout({
    height,
    margin: { l: 60, r: 56, t: 12, b: 34 },
    yaxis: { gridcolor: C.grid, showgrid: true, zeroline: false, tickfont: { family: FONT, color: C.amber, size: 10 }, tickprefix: "$", tickformat: ".2s" },
    yaxis2: { overlaying: "y", side: "right", showgrid: false, zeroline: false, tickfont: { family: FONT, color: C.teal, size: 10 }, tickformat: ".2s" },
    ...marks,
  });

  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

/**
 * Side-by-side placement across two y-axes: traces sharing an offsetgroup stack,
 * different offsetgroups get their own slot. Not in @types/plotly.js yet.
 */
function barGrouping<T extends object>(trace: T, group: string): Data {
  return { ...trace, offsetgroup: group, alignmentgroup: "week" } as unknown as Data;
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Shade ramp inside a weekly bar: Monday darkest → Sunday lightest, so the
// weekend's smaller share reads at a glance and neighbours stay tellable apart.
const DAY_ALPHAS = [0.95, 0.86, 0.77, 0.68, 0.59, 0.46, 0.36];

/**
 * The same market series summed into Mon–Sun weeks, each bar stacked from its
 * seven day-rectangles (Monday at the bottom). Daily spend carries a weekday
 * cycle that hides the trend; weekly bars remove it, and the stack keeps the
 * day-level texture without a second chart. In "both" the two metrics stand
 * side by side on their own axes. The week in progress simply has fewer
 * segments, with a hatched cap on top — that cap is the projected remainder.
 */
export function WeeklyBarsChart({
  weeks,
  mode,
  projected,
  height = 260,
}: {
  weeks: WeekBucket[];
  mode: "spend" | "tokens" | "both";
  /** Full-week estimate for the running week, per metric (null = no estimate). */
  projected?: { spend: number | null; tokens: number | null };
  height?: number;
}) {
  const showSpend = mode === "spend" || mode === "both";
  const showTokens = mode === "tokens" || mode === "both";

  const data = useMemo<Data[]>(() => {
    const x = weeks.map((w) => w.weekStart);
    const last = weeks[weeks.length - 1];
    const money = (v: number) => `$${fmtCompact(v)}`;
    const vol = (v: number) => `${fmtCompact(v)} tok`;

    const build = (metric: "spend" | "tokens"): Data[] => {
      const color = metric === "spend" ? C.amber : C.teal;
      const fmt = metric === "spend" ? money : vol;
      const y = weeks.map((w) => (metric === "spend" ? w.spendUsd : w.tokens));
      const axis = metric === "spend" || mode === "tokens" ? "y" : "y2";
      // Same offsetgroup = stacked (the 7 day segments + projection); different
      // offsetgroups sit side by side, which is how two axes share week slots.
      const group = metric;
      const cellValue = (cell: WeekDayCell | null | undefined) =>
        cell == null ? null : metric === "spend" ? cell.spendUsd : cell.tokens;
      // One trace per weekday: within a week slot they stack Mon (bottom) → Sun.
      // The legend is drawn from a single metric's set — the day names apply to both.
      const traces: Data[] = DAY_LABELS.map((label, dow) =>
        barGrouping({
          type: "bar",
          name: label,
          legendgroup: label,
          showlegend: metric === "spend" || mode === "tokens",
          x,
          y: weeks.map((w) => cellValue(w.byDay[dow])),
          yaxis: axis,
          marker: {
            color: hexToRgba(color, DAY_ALPHAS[dow] ?? 0.5),
            line: { color: "#ffffff", width: 0.6 },
          },
          hovertext: weeks.map((w, i) => {
            const v = cellValue(w.byDay[dow]);
            if (v === null) return "";
            const total = y[i] ?? 0;
            const share = w.complete && total > 0 ? ` · ${Math.round((v / total) * 100)}% of wk` : "";
            // Every segment repeats the week total — with per-rectangle hover
            // there is no other place to read the height of the whole stack.
            const week = total > 0 ? `<br>week ${w.complete ? "total" : `so far, ${w.days}d`}: ${fmt(total)}` : "";
            return `${label} ${w.byDay[dow]?.date ?? w.weekStart}<br>${fmt(v)}${share}${week}`;
          }),
          hovertemplate: "%{hovertext}<extra></extra>",
        }, group),
      );

      const full = (metric === "spend" ? projected?.spend : projected?.tokens) ?? null;
      if (last && !last.complete && full !== null) {
        const booked = y[weeks.length - 1] ?? 0;
        traces.push(barGrouping({
          type: "bar",
          name: "Projected",
          x: [last.weekStart],
          y: [Math.max(0, full - booked)],
          yaxis: axis,
          showlegend: false,
          marker: {
            color: hexToRgba(color, 0.1),
            line: { color, width: 1.2 },
            pattern: { shape: "/", size: 5, solidity: 0.22, fgcolor: color, bgcolor: "#ffffff" },
          },
          hovertext: [`Projected full week<br>${fmt(full)}<br>${fmt(booked)} booked in ${last.days} day${last.days === 1 ? "" : "s"}`],
          hovertemplate: "%{hovertext}<extra></extra>",
        }, group));
      }
      return traces;
    };

    return [...(showSpend ? build("spend") : []), ...(showTokens ? build("tokens") : [])];
  }, [weeks, mode, showSpend, showTokens, projected]);

  const leftColor = showSpend ? C.amber : C.teal;
  const layout = baseLayout({
    height,
    // "stack" + offsetgroup: booked and projected stack, metrics stay side by side.
    barmode: "stack",
    bargap: 0.3,
    bargroupgap: 0.12,
    margin: { l: 60, r: mode === "both" ? 58 : 16, t: 30, b: 46 },
    hovermode: "closest",
    // Mon…Sun legend doubles as the shade key; clicking a day hides it in
    // every week (legendgroup ties the spend and tokens copies together).
    showlegend: true,
    legend: {
      orientation: "h",
      x: 0,
      y: 1.02,
      yanchor: "bottom",
      font: { family: FONT, size: 10, color: C.muted },
      itemwidth: 30,
      traceorder: "normal",
    },
    // One tick per week slot, on the Monday it starts.
    xaxis: { type: "date", tickformat: "%b %-d", tickmode: "array", tickvals: weeks.map((w) => w.weekStart), tickangle: -45 },
    yaxis: {
      gridcolor: C.grid,
      showgrid: true,
      zeroline: false,
      tickfont: { family: FONT, color: leftColor, size: 10 },
      tickformat: ".2s",
      ...(showSpend ? { tickprefix: "$" } : {}),
    },
    ...(mode === "both"
      ? {
          yaxis2: {
            overlaying: "y",
            side: "right",
            showgrid: false,
            zeroline: false,
            rangemode: "tozero",
            tickfont: { family: FONT, color: C.teal, size: 10 },
            tickformat: ".2s",
          },
        }
      : {}),
  });

  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

/** Price index over time: usage-weighted + median $/Mtok from market snapshots. */
export function PriceIndexChart({
  rows,
  height = 260,
}: {
  rows: { date: string; weightedUsdPerMtok: number | null; medianUsdPerMtok: number | null }[];
  height?: number;
}) {
  const data = useMemo<Data[]>(() => {
    const x = rows.map((s) => s.date);
    return [
      {
        type: "scatter",
        mode: "lines",
        name: "Usage-weighted",
        x,
        y: rows.map((s) => s.weightedUsdPerMtok),
        line: { color: C.amber, width: 2.2 },
        hovertemplate: "$%{y:.3~f}<extra>weighted</extra>",
      },
      {
        type: "scatter",
        mode: "lines",
        name: "Median",
        x,
        y: rows.map((s) => s.medianUsdPerMtok),
        line: { color: C.indigo, width: 1.6, dash: "dot" },
        hovertemplate: "$%{y:.3~f}<extra>median</extra>",
      },
    ];
  }, [rows]);

  const layout = baseLayout({ height, yaxis: { gridcolor: C.grid, showgrid: true, zeroline: false, tickprefix: "$", tickfont: { family: FONT, color: C.tick, size: 10 } } });
  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

// ---------------------------------------------------------------------------
// Compute — vast.ai GPU rental market
// ---------------------------------------------------------------------------

/**
 * One accelerator's rental price over time. The hero line is the 25th-percentile
 * ask — a quarter into the fenced book, offer #10 of a 40-offer book — because
 * the single cheapest box is one lucky host that gets rented away in minutes,
 * while a quarter in is a price still standing an hour later. Cheapest → median
 * frame it as a quiet band, and supply bars sit under everything on a second
 * axis so price moves read against book depth.
 */
export function GpuBandChart({
  points,
  height = 340,
}: {
  points: {
    date: string;
    minUsd: number | null;
    medianUsd: number | null;
    p25Usd: number | null;
    gpusAvailable?: number;
  }[];
  height?: number;
}) {
  const hasDepth = points.some((p) => (p.gpusAvailable ?? 0) > 0);

  const data = useMemo<Data[]>(() => {
    const x = points.map((p) => p.date);
    const traces: Data[] = [];

    if (hasDepth) {
      traces.push({
        type: "scatter",
        mode: "lines",
        name: "GPUs on offer",
        x,
        y: points.map((p) => p.gpusAvailable ?? null),
        yaxis: "y2",
        line: { color: "rgba(196, 101, 15, 0.65)", width: 1.1, shape: "hv" },
        fill: "tozeroy",
        fillcolor: DEPTH_FILL,
        hovertemplate: "%{y} GPUs<extra>depth</extra>",
      });
    }

    // Band edges: cheapest below, median above, quiet fill between them. The
    // median must follow the min in this array — tonexty pairs neighbours.
    traces.push({
      type: "scatter",
      mode: "lines",
      name: "Cheapest offer",
      x,
      y: points.map((p) => p.minUsd),
      line: { color: C.indigo, width: 1.1 },
      hovertemplate: "$%{y:.3~f}/GPU-hr<extra>min</extra>",
    });
    traces.push({
      type: "scatter",
      mode: "lines",
      name: "Median offer",
      x,
      y: points.map((p) => p.medianUsd),
      line: { color: C.indigo, width: 1.1, dash: "dot" },
      fill: "tonexty",
      fillcolor: "rgba(43,52,204,0.14)",
      hovertemplate: "$%{y:.3~f}/GPU-hr<extra>median</extra>",
    });
    traces.push({
      type: "scatter",
      // Markers make sparse series readable; past a few hundred points (the
      // 15-min sweep tape) they fuse into a rope, so lines only.
      mode: points.length <= 300 ? "lines+markers" : "lines",
      name: "P25 offer — ¼ into the book",
      x,
      y: points.map((p) => p.p25Usd),
      line: { color: C.min, width: 2.4 },
      marker: { size: 4, color: C.min },
      hovertemplate: "$%{y:.3~f}/GPU-hr<extra>p25</extra>",
    });
    return traces;
  }, [points, hasDepth]);

  const layout = baseLayout({
    height,
    showlegend: true,
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { family: FONT, size: 11, color: C.muted } },
    margin: { l: 62, r: hasDepth ? 46 : 18, t: 46, b: 34 },
    yaxis: {
      gridcolor: C.grid,
      showgrid: true,
      zeroline: false,
      tickprefix: "$",
      tickfont: { family: FONT, color: C.tick, size: 10 },
      title: { text: "USD / GPU-hour", font: { family: FONT, size: 10, color: C.muted } },
    },
    ...(hasDepth
      ? {
          // Depth axis: right side, no grid (the $ grid is the reading grid), and
          // a hard floor at zero so the bars sit on the axis instead of floating.
          yaxis2: {
            overlaying: "y",
            side: "right",
            rangemode: "tozero",
            showgrid: false,
            zeroline: false,
            tickfont: { family: FONT, color: DEPTH_AXIS, size: 10 },
            title: { text: "GPUs", font: { family: FONT, size: 10, color: DEPTH_AXIS } },
          } as never,
        }
      : {}),
  });

  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

/**
 * The intraday tape for one accelerator: every sweep of the trailing window,
 * floor + median lines against a supply-depth underlay on a second axis. The
 * point of the depth bars is causality-at-a-glance: when GPUs get rented the
 * book thins and the floor climbs — visible as bars dropping, line rising.
 */
export function IntradayTapeChart({
  rows,
  height = 300,
}: {
  rows: {
    capturedAt: string;
    minUsd: number | null;
    medianUsd: number | null;
    gpusAvailable: number;
  }[];
  height?: number;
}) {
  const data = useMemo<Data[]>(() => {
    const x = rows.map((r) => r.capturedAt);
    // A week of 15-minute sweeps is ~670 points: per-sweep markers stop being
    // dots and become a band. Past a few hundred, the line alone reads better.
    const minMode = rows.length > 300 ? "lines" : "lines+markers";
    return [
      {
        type: "scatter",
        mode: "lines",
        name: "GPUs on offer",
        x,
        y: rows.map((r) => r.gpusAvailable),
        yaxis: "y2",
        line: { color: "rgba(196, 101, 15, 0.65)", width: 1.1, shape: "hv" },
        fill: "tozeroy",
        fillcolor: DEPTH_FILL,
        hovertemplate: "%{y} GPUs<extra>depth</extra>",
      },
      {
        type: "scatter",
        mode: "lines",
        name: "Median offer",
        x,
        y: rows.map((r) => r.medianUsd),
        line: { color: C.indigo, width: 1.6, dash: "dot" },
        hovertemplate: "$%{y:.3~f}/GPU-hr<extra>median</extra>",
      },
      {
        type: "scatter",
        mode: minMode,
        name: "Cheapest offer",
        x,
        y: rows.map((r) => r.minUsd),
        line: { color: C.min, width: 2.2 },
        marker: { size: 4, color: C.min },
        hovertemplate: "$%{y:.3~f}/GPU-hr<extra>min</extra>",
      },
    ];
  }, [rows]);

  const layout = baseLayout({
    height,
    showlegend: true,
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { family: FONT, size: 11, color: C.muted } },
    margin: { l: 56, r: 46, t: 46, b: 34 },
    yaxis: {
      gridcolor: C.grid,
      showgrid: true,
      zeroline: false,
      tickprefix: "$",
      tickfont: { family: FONT, color: C.tick, size: 10 },
      title: { text: "USD / GPU-hour", font: { family: FONT, size: 10, color: C.muted } },
    },
    // Depth axis: right side, no grid (the $ grid is the reading grid), and a
    // hard floor at zero so the bars sit on the axis instead of floating.
    yaxis2: {
      overlaying: "y",
      side: "right",
      rangemode: "tozero",
      showgrid: false,
      zeroline: false,
      tickfont: { family: FONT, color: DEPTH_AXIS, size: 10 },
      title: { text: "GPUs", font: { family: FONT, size: 10, color: DEPTH_AXIS } },
    } as never,
  });

  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

/**
 * Hour-of-day seasonality: each series is that metric's median per UTC hour,
 * normalized so 100 = a typical hour. Reads directly as "when is it cheap":
 * a floor line at 95 at 04:00 means the small hours run 5% under typical.
 */
export function HourProfileChart({
  series,
  height = 300,
}: {
  series: {
    name: string;
    color: string;
    dash?: "solid" | "dot" | "dash";
    profile: { hour: number; index: number | null; samples: number }[];
  }[];
  height?: number;
}) {
  const data = useMemo<Data[]>(
    () =>
      series.map((s) => ({
        type: "scatter" as const,
        mode: "lines+markers" as const,
        name: s.name,
        x: s.profile.map((p) => p.hour),
        y: s.profile.map((p) => p.index),
        connectgaps: false,
        line: { color: s.color, width: 2, dash: s.dash ?? "solid" },
        marker: { size: 4, color: s.color },
        customdata: s.profile.map((p) => p.samples) as unknown as number[],
        hovertemplate: `%{y:.1f} · n=%{customdata}<extra>${escapeHtml(s.name)}</extra>`,
      })),
    [series],
  );

  const layout = baseLayout({
    height,
    showlegend: true,
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { family: FONT, size: 11, color: C.muted } },
    margin: { l: 48, r: 18, t: 46, b: 40 },
    xaxis: {
      gridcolor: C.grid,
      showgrid: false,
      zeroline: false,
      tickmode: "array",
      tickvals: [0, 3, 6, 9, 12, 15, 18, 21],
      ticktext: ["00", "03", "06", "09", "12", "15", "18", "21"],
      range: [-0.5, 23.5],
      tickfont: { family: FONT, color: C.tick, size: 10 },
      title: { text: "hour of day (UTC)", font: { family: FONT, size: 10, color: C.muted } },
      ...AXIS_SPIKE,
    } as never,
    yaxis: {
      gridcolor: C.grid,
      showgrid: true,
      zeroline: false,
      tickfont: { family: FONT, color: C.tick, size: 10 },
      title: { text: "index (100 = typical hour)", font: { family: FONT, size: 10, color: C.muted } },
    },
    shapes: [
      {
        type: "line",
        xref: "paper",
        x0: 0,
        x1: 1,
        yref: "y",
        y0: 100,
        y1: 100,
        line: { color: C.line, width: 1, dash: "dash" },
      },
    ],
  });

  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

/**
 * Token price vs. raw compute price, both rebased to 100 at the left edge.
 *
 * The units genuinely don't convert ($/Mtok vs $/GPU-hour), so the chart
 * compares slopes rather than levels — the y-axis is an index, and the raw
 * values live in the tooltip so nobody has to read a ratio off the plot.
 */
export function ComputeVsTokensChart({
  dates,
  tokenIndex,
  gpuIndex,
  tokenRaw,
  gpuRaw,
  gpuLabel,
  height = 320,
}: {
  dates: string[];
  tokenIndex: (number | null)[];
  gpuIndex: (number | null)[];
  tokenRaw: (number | null)[];
  gpuRaw: (number | null)[];
  gpuLabel: string;
  height?: number;
}) {
  const data = useMemo<Data[]>(
    () => [
      {
        type: "scatter",
        mode: "lines",
        name: "Token price (weighted $/Mtok)",
        x: dates,
        y: tokenIndex,
        line: { color: C.amber, width: 2.2 },
        customdata: tokenRaw as unknown as number[],
        hovertemplate: "index %{y:.1f} · $%{customdata:.4~f}/Mtok<extra>tokens</extra>",
      },
      {
        type: "scatter",
        mode: "lines",
        name: `${gpuLabel} rental ($/GPU-hr)`,
        x: dates,
        y: gpuIndex,
        line: { color: C.min, width: 2.2 },
        customdata: gpuRaw as unknown as number[],
        hovertemplate: "index %{y:.1f} · $%{customdata:.3~f}/GPU-hr<extra>compute</extra>",
      },
    ],
    [dates, tokenIndex, gpuIndex, tokenRaw, gpuRaw, gpuLabel],
  );

  const layout = baseLayout({
    height,
    showlegend: true,
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { family: FONT, size: 11, color: C.muted } },
    margin: { l: 52, r: 18, t: 46, b: 34 },
    yaxis: {
      gridcolor: C.grid,
      showgrid: true,
      zeroline: false,
      tickfont: { family: FONT, color: C.tick, size: 10 },
      title: { text: "index (start = 100)", font: { family: FONT, size: 10, color: C.muted } },
    },
    shapes: [
      {
        type: "line",
        xref: "paper",
        x0: 0,
        x1: 1,
        yref: "y",
        y0: 100,
        y1: 100,
        line: { color: C.line, width: 1, dash: "dash" },
      },
    ],
  });

  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

/** Model price history: prompt + completion $/Mtok (model-level, step lines). */
export function PriceHistoryChart({ rows, height = 300 }: { rows: PriceHistoryRow[]; height?: number }) {
  const data = useMemo<Data[]>(() => {
    const x = xdates(rows, "observedAt");
    const toMtok = (v: number | null) => (v === null ? null : v * 1_000_000);
    return [
      {
        type: "scatter",
        mode: "lines+markers",
        name: "Input",
        x,
        y: rows.map((r) => toMtok(r.promptUsd)),
        line: { color: C.indigo, width: 2, shape: "hv" },
        marker: { size: 4, color: C.indigo },
        hovertemplate: "$%{y:.4~f}/M<extra>input</extra>",
      },
      {
        type: "scatter",
        mode: "lines+markers",
        name: "Output",
        x,
        y: rows.map((r) => toMtok(r.completionUsd)),
        line: { color: C.amber, width: 2, shape: "hv" },
        marker: { size: 4, color: C.amber },
        hovertemplate: "$%{y:.4~f}/M<extra>output</extra>",
      },
    ];
  }, [rows]);

  // Anchored at $0: prices are ratios to zero, and a cropped axis turns a
  // stable price into what looks like wild swings.
  const layout = baseLayout({ height, yaxis: { gridcolor: C.grid, showgrid: true, zeroline: false, rangemode: "tozero", tickprefix: "$", tickfont: { family: FONT, color: C.tick, size: 10 } } });
  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

/** Model usage history: estimated spend (amber area, primary) + daily tokens (teal line, 2nd axis). */
export function UsageHistoryChart({
  rows,
  height = 300,
  nowMs = Date.now(),
}: {
  rows: UsageRow[];
  height?: number;
  nowMs?: number;
}) {
  const { data, marks } = useMemo(() => {
    const x = xdates(rows, "bucketDate");
    const idx = runningIndex(x, nowMs);
    const spend = rows.map((r) => r.estimatedSpendUsd);
    const tokens = rows.map((r) => r.tokens);
    const out: Data[] = [
      {
        type: "scatter",
        mode: "lines",
        name: "Est. spend",
        x,
        y: untilRunning(spend, idx),
        line: { color: C.amber, width: 2 },
        fill: "tozeroy",
        fillcolor: "rgba(176,106,6,0.07)",
        hovertemplate: "$%{y:,.0f}<extra>spend</extra>",
      },
      {
        type: "scatter",
        mode: "lines",
        name: "Tokens",
        x,
        y: untilRunning(tokens, idx),
        line: { color: C.teal, width: 1.4 },
        yaxis: "y2",
        hovertemplate: "%{y:.3s} tok<extra>tokens</extra>",
      },
    ];
    if (idx > 0) {
      out.push(
        {
          type: "scatter",
          mode: "lines",
          name: "Est. spend (today)",
          x,
          y: fromRunning(spend, idx),
          line: { color: C.amber, width: 2, dash: "dot" },
          fill: "tozeroy",
          fillcolor: "rgba(176,106,6,0.035)",
          hovertemplate: "$%{y:,.0f}<extra>spend so far today</extra>",
        },
        {
          type: "scatter",
          mode: "lines",
          name: "Tokens (today)",
          x,
          y: fromRunning(tokens, idx),
          line: { color: C.teal, width: 1.4, dash: "dot" },
          yaxis: "y2",
          hovertemplate: "%{y:.3s} tok<extra>tokens so far today</extra>",
        },
      );
    }
    return { data: out, marks: runningDayMarks(x, idx) };
  }, [rows, nowMs]);

  const layout = baseLayout({
    height,
    margin: { l: 56, r: 56, t: 12, b: 34 },
    yaxis: { gridcolor: C.grid, showgrid: true, zeroline: false, tickprefix: "$", tickformat: ".2s", tickfont: { family: FONT, color: C.amber, size: 10 } },
    yaxis2: { overlaying: "y", side: "right", showgrid: false, zeroline: false, tickformat: ".2s", tickfont: { family: FONT, color: C.teal, size: 10 } },
    ...marks,
  });
  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

const RACE_COLORS = [C.min, C.teal, C.amber, C.up, C.down, C.violet, "#a83c8f", "#5b7ea8", "#8a6a1f", "#2f8f9a"];

// Provider color families for the stacked bar view. The four labs that
// actually contest the top of the board each get a brand-adjacent hue;
// everything else stacks into one neutral "Others" bar. Within a family the
// models ramp from saturated (biggest) to pale — the same trick the weekly
// bars use for weekdays.
const RACE_GROUP_ORDER = ["Anthropic", "OpenAI", "X.AI", "Z.AI", "Others"];
const RACE_GROUP_COLORS: Record<string, string> = {
  Anthropic: "#c15f3c",
  OpenAI: "#10a37f",
  "X.AI": "#24292f",
  "Z.AI": "#3b3fc4",
  Others: "#71808f",
};
/** The lab family a model slug stacks under — keyed off the author segment. */
function raceGroup(modelId: string): string {
  const author = (modelId.split("/")[0] ?? "").toLowerCase();
  if (author === "anthropic") return "Anthropic";
  if (author === "openai") return "OpenAI";
  if (author === "x-ai" || author === "xai") return "X.AI";
  if (author === "z-ai" || author === "zhipu") return "Z.AI";
  return "Others";
}

export type RaceMode = "spend" | "tokens";
export type RaceBucket = "week" | "day";
export type RaceStyle = "line" | "bar";

/**
 * The race for the top models, built from our own daily snapshots (real
 * per-model est. spend — no "Others" bucket, no top-10 membership dropouts).
 * Default mode ranks by **spend**; a tokens mode is kept as the secondary view.
 *
 * `bucket` only changes what one point means — full ISO weeks, or single days.
 * The daily series is the noisier read (weekday seasonality is worth ~20% on
 * its own) but it is where a launch or a routing switch actually shows up, on
 * the day it happened rather than smeared across a week bar.
 *
 * `style` picks the mark. Lines let you follow ten trends at a glance without
 * crowding; bars are the additive read — one bar per lab family (Anthropic,
 * OpenAI, X.AI, Z.AI, Others) with that lab's models stacked inside it, so a
 * bar's height is what the lab moved that day and the shade bands say which
 * model carried it. Stacking absorbs a wider field than grouping did, so bar
 * mode takes a larger `topN` than the line view.
 */
export function ModelRaceChart({
  points,
  height = 300,
  topN = 10,
  mode = "spend",
  bucket = "week",
  style = "line",
  pinned = [],
  nowMs = Date.now(),
}: {
  points: { date: string; spendByModel: Record<string, number>; tokensByModel: Record<string, number> }[];
  height?: number;
  topN?: number;
  mode?: RaceMode;
  bucket?: RaceBucket;
  style?: RaceStyle;
  /** Bar view only: models named even when they rank outside the top field. */
  pinned?: string[];
  nowMs?: number;
}) {
  const { data } = useMemo(() => {
    const dateLabel = bucket === "week" ? "week of %{x|%b %-d}" : "%{x|%b %-d}";
    const values = (p: (typeof points)[number]) => (mode === "spend" ? p.spendByModel : p.tokensByModel) ?? {};

    const totals = new Map<string, number>();
    for (const p of points) {
      for (const [k, v] of Object.entries(values(p))) {
        totals.set(k, (totals.get(k) ?? 0) + (Number(v) || 0));
      }
    }
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k]) => k);
    const x = points.map((p) => p.date);
    const hover = (name: string) =>
      mode === "spend"
        ? `${name}: $%{y:.3s} · ${dateLabel}<extra></extra>`
        : `${name}: %{y:.3s} tok · ${dateLabel}<extra></extra>`;
    // Bars need a real 0 for a bucket where the model was silent, otherwise
    // the stack misplaces every segment above the gap. Lines want the null so
    // Plotly breaks the line at gaps rather than drawing across them.
    const yFor = (p: (typeof points)[number], modelId: string): number | null => {
      const v = values(p)[modelId];
      if (v != null) return Number(v) || 0;
      return style === "bar" ? 0 : null;
    };

    if (style === "bar") {
      // One bar per lab per bucket, its models stacked inside. The named field
      // is the overall top plus any pinned models the data carries; within a
      // lab, members sort by window total so the biggest sits at the bottom of
      // the stack wearing the most saturated shade. Whatever the payload holds
      // beyond the named field sums into a pale "+N more" cap on its own lab's
      // bar, so every stack adds up to that lab's whole tracked book.
      const named = new Set(top);
      for (const m of pinned) if (totals.has(m)) named.add(m);
      const membersOf = new Map<string, string[]>();
      const restOf = new Map<string, string[]>();
      for (const modelId of [...totals.keys()].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))) {
        const g = raceGroup(modelId);
        const bucket_ = named.has(modelId) ? membersOf : restOf;
        bucket_.set(g, [...(bucket_.get(g) ?? []), modelId]);
      }
      const fmt = (v: number) => (mode === "spend" ? `$${fmtCompact(v)}` : `${fmtCompact(v)} tok`);
      const traces: Data[] = [];
      for (const g of RACE_GROUP_ORDER) {
        const members = membersOf.get(g) ?? [];
        const rest = restOf.get(g) ?? [];
        if (members.length === 0 && rest.length === 0) continue;
        const color = RACE_GROUP_COLORS[g]!;
        const restAt = (p: (typeof points)[number]) =>
          rest.reduce((sum, m) => sum + (Number(values(p)[m]) || 0), 0);
        const groupTotal = (p: (typeof points)[number]) =>
          members.reduce((sum, m) => sum + (Number(values(p)[m]) || 0), 0) + restAt(p);
        members.forEach((modelId, i) => {
          const alpha = members.length === 1 ? 0.92 : Math.max(0.33, 0.95 - (i * 0.62) / (members.length - 1));
          traces.push(
            barGrouping(
              {
                type: "bar",
                name: shortSlug(modelId),
                legendgroup: g,
                legendgrouptitle: { text: g, font: { family: FONT, size: 10, color } },
                x,
                y: points.map((p) => yFor(p, modelId)),
                marker: { color: hexToRgba(color, alpha), line: { color: "#ffffff", width: 0.5 } },
                // Every segment repeats its lab's day total — with per-segment
                // hover there is no other place to read the stack's height.
                hovertext: points.map((p) => {
                  const v = Number(values(p)[modelId]) || 0;
                  const total = groupTotal(p);
                  return `${shortSlug(modelId)} · ${fmt(v)}${total > 0 ? `<br>${g} total: ${fmt(total)}` : ""}`;
                }),
                hovertemplate: `%{hovertext}<br>${dateLabel}<extra></extra>`,
              },
              g,
            ),
          );
        });
        if (rest.length > 0) {
          traces.push(
            barGrouping(
              {
                type: "bar",
                name: `${g} · +${rest.length} more`,
                legendgroup: g,
                legendgrouptitle: { text: g, font: { family: FONT, size: 10, color } },
                x,
                y: points.map((p) => restAt(p)),
                marker: { color: hexToRgba(color, 0.2), line: { color: "#ffffff", width: 0.5 } },
                hovertext: points.map((p) => {
                  const total = groupTotal(p);
                  return `+${rest.length} more ${g} models · ${fmt(restAt(p))}${total > 0 ? `<br>${g} total: ${fmt(total)}` : ""}`;
                }),
                hovertemplate: `%{hovertext}<br>${dateLabel}<extra></extra>`,
              },
              g,
            ),
          );
        }
      }
      return { data: traces };
    }

    const traces: Data[] = top.map((modelId, i) => {
      const color = RACE_COLORS[i % RACE_COLORS.length]!;
      const name = shortSlug(modelId);
      return {
        type: "scatter",
        mode: "lines",
        name,
        x,
        y: points.map((p) => yFor(p, modelId)),
        line: { color, width: bucket === "week" ? 1.8 : 1.4 },
        hovertemplate: hover(name),
      };
    });
    return { data: traces };
  }, [points, topN, mode, bucket, style, pinned]);

  // Ten lines cannot each grow a dotted tail without doubling the legend and
  // the hover stack, so the day in progress gets the shaded band alone — the
  // same call ProviderRevenueChart makes. Weeks never need it: partial weeks
  // are dropped server-side.
  const marks = useMemo(() => {
    if (bucket !== "day") return {};
    const dates = points.map((p) => p.date);
    return runningDayMarks(dates, runningIndex(dates, nowMs));
  }, [points, bucket, nowMs]);

  const layout = baseLayout({
    height,
    // Bars carry their own tooltip per group already; a unified hover would
    // stack all five and make the tallest one unreadable.
    hovermode: "closest",
    showlegend: true,
    // Anchor the legend's bottom above the plot so its ~4 wrapped rows grow
    // into the top margin instead of down over the traces.
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { family: FONT, size: 9.5, color: C.muted } },
    margin: { l: 52, r: 12, t: 86, b: 34 },
    // "stack" + offsetgroup per lab: models stack inside their lab's bar,
    // labs stand side by side within the bucket slot.
    ...(style === "bar" ? { barmode: "stack", bargap: 0.25, bargroupgap: 0.06 } : {}),
    yaxis: {
      gridcolor: C.grid,
      showgrid: true,
      zeroline: false,
      tickformat: ".2s",
      ...(mode === "spend" ? { tickprefix: "$" } : {}),
      tickfont: { family: FONT, color: C.tick, size: 10 },
    },
    ...marks,
  });
  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

/**
 * Provider revenue tape: stacked daily est. revenue (or tokens) per provider.
 * Traces arrive pre-assembled (name, x, y, color), biggest provider first so
 * it sits at the bottom of the stack. `benchmark` draws the whole market's
 * daily total over the stack as a neutral reference line — same units, same
 * axis — so the head-of-market tape can be read against the full catalog.
 */
export function ProviderRevenueChart({
  traces,
  mode,
  height = 320,
  benchmark = null,
  nowMs = Date.now(),
}: {
  traces: { name: string; x: string[]; y: (number | null)[]; color: string }[];
  mode: "spend" | "tokens";
  height?: number;
  benchmark?: { name: string; x: string[]; y: (number | null)[] } | null;
  nowMs?: number;
}) {
  // The tape always carries a day in progress — the per-provider sweep writes
  // it every pass — so the band is the normal state here, not the exception.
  // A stacked area cannot go dotted without unstacking, so the shading and its
  // label do the whole job.
  const marks = useMemo(() => runningDayMarks(traces[0]?.x ?? [], runningIndex(traces[0]?.x ?? [], nowMs)), [traces, nowMs]);

  const data = useMemo<Data[]>(() => {
    const out: Data[] = traces.map((t) => ({
      type: "scatter",
      mode: "lines",
      name: t.name,
      x: t.x,
      y: t.y,
      stackgroup: "one",
      line: { width: 0.6, color: t.color },
      fillcolor: hexToRgba(t.color, 0.55),
      hovertemplate: `${mode === "spend" ? "$%{y:.3~s}" : "%{y:.3~s} tok"} · ${escapeHtml(t.name)}<extra></extra>`,
    }));
    // No stackgroup: the reference line reads absolute, not stacked on top.
    if (benchmark) {
      out.push({
        type: "scatter",
        mode: "lines",
        name: benchmark.name,
        x: benchmark.x,
        y: benchmark.y,
        line: { width: 2, color: C.ink, dash: "dot" },
        hovertemplate: `${mode === "spend" ? "$%{y:.3~s}" : "%{y:.3~s} tok"} · ${escapeHtml(benchmark.name)}<extra></extra>`,
      });
    }
    return out;
  }, [traces, mode, benchmark]);

  const layout = baseLayout({
    height,
    showlegend: true,
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { family: FONT, size: 10, color: C.muted } },
    margin: { l: 56, r: 14, t: 46, b: 34 },
    yaxis: {
      gridcolor: C.grid,
      showgrid: true,
      zeroline: false,
      ...(mode === "spend" ? { tickprefix: "$" } : {}),
      tickfont: { family: FONT, color: C.tick, size: 10 },
    },
    xaxis: { gridcolor: C.grid, showgrid: false, ...AXIS_SPIKE, tickfont: { family: FONT, color: C.tick, size: 10 } },
    ...marks,
  });

  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function shortSlug(slug: string): string {
  const [path, variant] = slug.split(":");
  const base = (path ?? slug).split("/").pop() ?? slug;
  const name = base.replace(/-\d{6,8}$/, "").slice(0, 22);
  return variant ? `${name}:${variant}` : name;
}

function fmtCompact(v: number): string {
  if (v >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

function fmtPrice(v: number): string {
  if (v === 0) return "0";
  if (v < 1) return v.toFixed(3);
  if (v < 100) return v.toFixed(2);
  return v.toFixed(0);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

/** Tiny inline SVG sparkline (static, no Plotly) for KPI cards. */
export function Sparkline({
  values,
  color = C.teal,
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
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${gid})`} />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
