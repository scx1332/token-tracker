import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-dist-min";
import type { Layout, Config, Data } from "plotly.js-dist-min";
import { useMemo } from "react";
import type { PriceHistoryRow, UsageRow, UsageSeriesPoint } from "./api";
import type { WeekBucket } from "./weekly";

export const Plot = createPlotlyComponent(Plotly);

// Light, print-legible data palette. Neutrals carry the page; color only ever
// encodes meaning: teal = tokens/volume, amber = dollars/spend, indigo = price
// (and the minimum-price line is the strongest blue on the page).
export const C = {
  ink: "#111722",
  text: "#111722",
  muted: "#586576",
  faint: "#8b97a6",
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

const MONO = "IBM Plex Mono, ui-monospace, monospace";

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
    font: { family: MONO, color: C.muted, size: 11 },
    margin: { l: 56, r: 16, t: 12, b: 34 },
    hovermode: "x unified",
    hoverlabel: {
      bgcolor: "#ffffff",
      bordercolor: C.line,
      font: { family: MONO, color: C.ink, size: 12 },
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
      tickfont: { family: MONO, color: C.faint, size: 10 },
      showgrid: false,
      ...AXIS_SPIKE,
      ...(xaxis ?? {}),
    },
    yaxis: {
      gridcolor: C.grid,
      linecolor: C.line,
      zeroline: false,
      showgrid: true,
      tickfont: { family: MONO, color: C.faint, size: 10 },
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
// Price Explorer — the signature charts
// ---------------------------------------------------------------------------

/**
 * The cross-provider price envelope for one model: the cheapest-provider line
 * (bold, the "minimum" analysts track) inside the min–max spread band, with an
 * own step line for every provider the user has pinned. Prices are step
 * functions, so the lines use h-v interpolation; a rangeslider lets you scrub
 * the timeline.
 */
export function PriceEnvelopeChart({
  x,
  min,
  max,
  cheapest,
  providers,
  metricLabel,
  height = 400,
  showBand = true,
  rangeslider = true,
}: {
  x: string[];
  min: (number | null)[];
  max: (number | null)[];
  cheapest: (string | null)[];
  providers?: { name: string; x: string[]; y: (number | null)[]; color: string }[];
  metricLabel: string;
  height?: number;
  showBand?: boolean;
  rangeslider?: boolean;
}) {
  const data = useMemo<Data[]>(() => {
    const traces: Data[] = [];
    const bandVisible = showBand && max.some((v, i) => v != null && min[i] != null && (v as number) > (min[i] as number) + 1e-12);
    if (bandVisible) {
      traces.push({
        type: "scatter",
        mode: "lines",
        name: "spread-lower",
        x,
        y: min,
        line: { width: 0, shape: "hv" },
        hoverinfo: "skip",
        showlegend: false,
      });
      traces.push({
        type: "scatter",
        mode: "lines",
        name: "Provider spread",
        x,
        y: max,
        line: { width: 0, shape: "hv" },
        fill: "tonexty",
        fillcolor: "rgba(43,52,204,0.07)",
        hovertemplate: "high $%{y:.4~f}/M<extra>dearest</extra>",
        showlegend: true,
      });
    }
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
  }, [x, min, max, cheapest, providers, showBand]);

  const layout = baseLayout({
    height,
    showlegend: true,
    // yanchor bottom: wrapped legend rows grow upward instead of covering the plot.
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { family: MONO, size: 11, color: C.muted } },
    margin: { l: 62, r: 18, t: 52, b: rangeslider ? 20 : 34 },
    yaxis: {
      gridcolor: C.grid,
      showgrid: true,
      zeroline: false,
      tickprefix: "$",
      tickfont: { family: MONO, color: C.faint, size: 10 },
      title: { text: metricLabel, font: { family: MONO, size: 10, color: C.faint } },
    },
    xaxis: {
      gridcolor: C.grid,
      showgrid: false,
      ...AXIS_SPIKE,
      rangeslider: rangeslider ? { visible: true, thickness: 0.08, bgcolor: "#f4f6f9", bordercolor: C.line } : { visible: false },
      tickfont: { family: MONO, color: C.faint, size: 10 },
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
        textfont: { family: MONO, size: 10, color: "#ffffff" },
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
      tickfont: { family: MONO, color: C.faint, size: 10 },
      ...AXIS_SPIKE,
    },
    yaxis: { showgrid: false, automargin: true, tickfont: { family: MONO, color: C.muted, size: 10.5 }, linecolor: C.line },
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
        y: series.map((s) => s.totalTokens),
        line: { color: C.teal, width: 1.8 },
        yaxis: "y2",
        hovertemplate: "%{y:.3s} tok<extra>tokens</extra>",
      },
    ];
  }, [series]);

  const layout = baseLayout({
    height,
    margin: { l: 60, r: 56, t: 12, b: 34 },
    yaxis: { gridcolor: C.grid, showgrid: true, zeroline: false, tickfont: { family: MONO, color: C.amber, size: 10 }, tickprefix: "$", tickformat: ".2s" },
    yaxis2: { overlaying: "y", side: "right", showgrid: false, zeroline: false, tickfont: { family: MONO, color: C.teal, size: 10 }, tickformat: ".2s" },
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

/**
 * The same market series summed into Mon–Sun weeks. Daily spend carries a
 * weekday cycle that hides the trend; weekly bars remove it. In "both" the two
 * metrics stand side by side on their own axes. The week in progress is drawn
 * hollow with a hatched cap on top — that cap is the projected remainder.
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
      // Same offsetgroup = stacked (booked + projection); different offsetgroups
      // sit side by side, which is how two axes share one set of week slots.
      const group = metric;
      const traces: Data[] = [
        barGrouping({
          type: "bar",
          name: metric === "spend" ? "Est. spend" : "Tokens",
          x,
          y,
          yaxis: axis,
          marker: {
            color: weeks.map((w) => (w.complete ? hexToRgba(color, 0.85) : hexToRgba(color, 0.22))),
            line: { color, width: weeks.map((w) => (w.complete ? 0 : 1.4)) as unknown as number },
          },
          hovertext: weeks.map((w, i) => `${w.weekStart} → ${w.weekEnd}<br>${fmt(y[i] ?? 0)}${w.complete ? "" : `<br>${w.days} of 7 days booked`}`),
          hovertemplate: "%{hovertext}<extra></extra>",
        }, group),
      ];

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
    margin: { l: 60, r: mode === "both" ? 58 : 16, t: 12, b: 46 },
    hovermode: "closest",
    // One tick per week slot, on the Monday it starts.
    xaxis: { type: "date", tickformat: "%b %-d", tickmode: "array", tickvals: weeks.map((w) => w.weekStart), tickangle: -45 },
    yaxis: {
      gridcolor: C.grid,
      showgrid: true,
      zeroline: false,
      tickfont: { family: MONO, color: leftColor, size: 10 },
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
            tickfont: { family: MONO, color: C.teal, size: 10 },
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

  const layout = baseLayout({ height, yaxis: { gridcolor: C.grid, showgrid: true, zeroline: false, tickprefix: "$", tickfont: { family: MONO, color: C.faint, size: 10 } } });
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

  const layout = baseLayout({ height, yaxis: { gridcolor: C.grid, showgrid: true, zeroline: false, tickprefix: "$", tickfont: { family: MONO, color: C.faint, size: 10 } } });
  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

/** Model usage history: estimated spend (amber area, primary) + daily tokens (teal line, 2nd axis). */
export function UsageHistoryChart({ rows, height = 300 }: { rows: UsageRow[]; height?: number }) {
  const data = useMemo<Data[]>(() => {
    const x = xdates(rows, "bucketDate");
    return [
      {
        type: "scatter",
        mode: "lines",
        name: "Est. spend",
        x,
        y: rows.map((r) => r.estimatedSpendUsd),
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
        y: rows.map((r) => r.tokens),
        line: { color: C.teal, width: 1.4 },
        yaxis: "y2",
        hovertemplate: "%{y:.3s} tok<extra>tokens</extra>",
      },
    ];
  }, [rows]);

  const layout = baseLayout({
    height,
    margin: { l: 56, r: 56, t: 12, b: 34 },
    yaxis: { gridcolor: C.grid, showgrid: true, zeroline: false, tickprefix: "$", tickformat: ".2s", tickfont: { family: MONO, color: C.amber, size: 10 } },
    yaxis2: { overlaying: "y", side: "right", showgrid: false, zeroline: false, tickformat: ".2s", tickfont: { family: MONO, color: C.teal, size: 10 } },
  });
  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

const RACE_COLORS = [C.min, C.teal, C.amber, C.up, C.down, C.violet, "#a83c8f", "#5b7ea8", "#8a6a1f", "#2f8f9a"];

export type RaceMode = "spend" | "tokens";

/**
 * Weekly race for the top models, built from our own daily snapshots (real
 * per-model est. spend summed per full week — no "Others" bucket, no top-10
 * membership dropouts). Default mode ranks by **weekly spend**; a tokens mode
 * is kept as the secondary view.
 */
export function WeeklyRaceChart({
  points,
  height = 300,
  topN = 10,
  mode = "spend",
}: {
  points: { date: string; spendByModel: Record<string, number>; tokensByModel: Record<string, number> }[];
  height?: number;
  topN?: number;
  mode?: RaceMode;
}) {
  const { data } = useMemo(() => {
    const values = (p: (typeof points)[number]) => (mode === "spend" ? p.spendByModel : p.tokensByModel) ?? {};

    const totals = new Map<string, number>();
    for (const p of points) {
      for (const [k, v] of Object.entries(values(p))) {
        totals.set(k, (totals.get(k) ?? 0) + (Number(v) || 0));
      }
    }
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k]) => k);
    const x = points.map((p) => p.date);
    const traces: Data[] = top.map((modelId, i) => ({
      type: "scatter",
      mode: "lines",
      name: shortSlug(modelId),
      x,
      y: points.map((p) => {
        const v = values(p)[modelId];
        return v == null ? null : Number(v) || 0;
      }),
      line: { color: RACE_COLORS[i % RACE_COLORS.length], width: 1.8 },
      hovertemplate:
        mode === "spend"
          ? `${shortSlug(modelId)}: $%{y:.3s}<extra></extra>`
          : `${shortSlug(modelId)}: %{y:.3s}<extra></extra>`,
    }));
    return { data: traces };
  }, [points, topN, mode]);

  const layout = baseLayout({
    height,
    hovermode: "closest",
    showlegend: true,
    // Anchor the legend's bottom above the plot so its ~4 wrapped rows grow
    // into the top margin instead of down over the traces.
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { family: MONO, size: 9.5, color: C.muted } },
    margin: { l: 52, r: 12, t: 86, b: 34 },
    yaxis: {
      gridcolor: C.grid,
      showgrid: true,
      zeroline: false,
      tickformat: ".2s",
      ...(mode === "spend" ? { tickprefix: "$" } : {}),
      tickfont: { family: MONO, color: C.faint, size: 10 },
    },
  });
  return <Plot data={data} layout={layout} config={baseConfig} className="plot" style={{ width: "100%", height }} useResizeHandler />;
}

/**
 * Provider revenue tape: stacked daily est. revenue (or tokens) per provider.
 * Traces arrive pre-assembled (name, x, y, color), biggest provider first so
 * it sits at the bottom of the stack.
 */
export function ProviderRevenueChart({
  traces,
  mode,
  height = 320,
}: {
  traces: { name: string; x: string[]; y: (number | null)[]; color: string }[];
  mode: "spend" | "tokens";
  height?: number;
}) {
  const data = useMemo<Data[]>(
    () =>
      traces.map((t) => ({
        type: "scatter",
        mode: "lines",
        name: t.name,
        x: t.x,
        y: t.y,
        stackgroup: "one",
        line: { width: 0.6, color: t.color },
        fillcolor: hexToRgba(t.color, 0.55),
        hovertemplate: `${mode === "spend" ? "$%{y:.3~s}" : "%{y:.3~s} tok"} · ${escapeHtml(t.name)}<extra></extra>`,
      })),
    [traces, mode],
  );

  const layout = baseLayout({
    height,
    showlegend: true,
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: { family: MONO, size: 10, color: C.muted } },
    margin: { l: 56, r: 14, t: 46, b: 34 },
    yaxis: {
      gridcolor: C.grid,
      showgrid: true,
      zeroline: false,
      ...(mode === "spend" ? { tickprefix: "$" } : {}),
      tickfont: { family: MONO, color: C.faint, size: 10 },
    },
    xaxis: { gridcolor: C.grid, showgrid: false, ...AXIS_SPIKE, tickfont: { family: MONO, color: C.faint, size: 10 } },
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
