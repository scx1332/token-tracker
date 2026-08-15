import { encodeModelId } from "../routes";
import { useEffect, useMemo, useState } from "react";
import { api, type ProviderStat, type ProvidersMarketResponse } from "../api";
import { Loading, ErrorNote, Panel, SectionHead } from "../components";
import { ProviderRevenueChart, Sparkline, PROVIDER_COLORS, C } from "../charts";
import { usd, compact, mtok, displayName } from "../format";

/** Pricing-side display names for usage-side provider slugs. */
const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI",
  "azure": "Azure",
  "amazon-bedrock": "Amazon Bedrock",
  "google-vertex": "Google Vertex",
  "google-ai-studio": "Google AI Studio",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  deepinfra: "DeepInfra",
  moonshotai: "Moonshot AI",
  siliconflow: "SiliconFlow",
  coreweave: "CoreWeave",
  "z-ai": "Z.AI",
  "x-ai": "xAI",
  novita: "Novita",
  atlascloud: "AtlasCloud",
  gmicloud: "GMICloud",
  baseten: "BaseTen",
};

function providerLabel(slug: string): string {
  const known = PROVIDER_LABEL[slug];
  if (known) return known;
  return slug
    .split("-")
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

// Same model = same hue on every provider's composition bar.
const MODEL_COLORS = [
  ...PROVIDER_COLORS,
  "#a04b7d", "#4b7ba0", "#7d8f2a", "#b8860b", "#5f9ea0", "#8e6bbf", "#c26d4b", "#3aa17e",
];
const OTHER_COLOR = "rgba(139,151,166,0.45)";

interface Desk {
  slug: string;
  name: string;
  spendPerDay: number;
  prevSpendPerDay: number | null;
  tokensPerDay: number;
  modelCount: number;
  spark: number[];
  composition: { modelId: string; label: string; share: number; color: string }[];
}

export function ProvidersView({ navigate }: { navigate: (to: string) => void }) {
  const [market, setMarket] = useState<ProvidersMarketResponse | null>(null);
  const [stats, setStats] = useState<ProviderStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"spend" | "tokens">("spend");

  useEffect(() => {
    let alive = true;
    Promise.all([api.providersMarket(90), api.providers()])
      .then(([m, p]) => {
        if (!alive) return;
        setMarket(m);
        setStats(p.providers);
      })
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  // Complete days only — the trailing bucket is partial and reads as a crash.
  const dates = useMemo(() => {
    const all = [...new Set((market?.series ?? []).map((s) => s.bucketDate))].sort();
    return all.slice(0, -1);
  }, [market]);

  const desks = useMemo<Desk[]>(() => {
    if (!market || dates.length === 0) return [];
    const cur7 = new Set(dates.slice(-7));
    const prev7 = new Set(dates.slice(-14, -7));
    const daySet = new Set(dates);

    const byProvider = new Map<string, { cur: number; prev: number; curTok: number; days: Map<string, number>; models: number }>();
    for (const s of market.series) {
      if (!daySet.has(s.bucketDate)) continue;
      const b = byProvider.get(s.provider) ?? { cur: 0, prev: 0, curTok: 0, days: new Map(), models: 0 };
      if (cur7.has(s.bucketDate)) {
        b.cur += s.spendUsd ?? 0;
        b.curTok += s.tokens ?? 0;
        b.models = Math.max(b.models, s.models);
      }
      if (prev7.has(s.bucketDate)) b.prev += s.spendUsd ?? 0;
      b.days.set(s.bucketDate, s.spendUsd ?? 0);
      byProvider.set(s.provider, b);
    }

    // Global model color assignment: the window's top models wear fixed hues.
    const modelSpend = new Map<string, number>();
    for (const m of market.models) modelSpend.set(m.modelId, (modelSpend.get(m.modelId) ?? 0) + (m.spendUsd ?? 0));
    const colorByModel = new Map(
      [...modelSpend.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MODEL_COLORS.length)
        .map(([id], i) => [id, MODEL_COLORS[i]!]),
    );

    return [...byProvider.entries()]
      .sort((a, b) => b[1].cur - a[1].cur)
      .slice(0, 10)
      .map(([slug, b]) => {
        const mine = market.models.filter((m) => m.provider === slug);
        const total = mine.reduce((s, m) => s + (m.spendUsd ?? 0), 0) || 1;
        const top = mine.slice(0, 4).map((m) => ({
          modelId: m.modelId,
          label: displayName(m.name),
          share: (m.spendUsd ?? 0) / total,
          color: colorByModel.get(m.modelId) ?? OTHER_COLOR,
        }));
        const rest = 1 - top.reduce((s, t) => s + t.share, 0);
        if (rest > 0.02) top.push({ modelId: "__rest__", label: `+${mine.length - top.length} more`, share: rest, color: OTHER_COLOR });
        return {
          slug,
          name: providerLabel(slug),
          spendPerDay: b.cur / 7,
          prevSpendPerDay: prev7.size >= 7 ? b.prev / 7 : null,
          tokensPerDay: b.curTok / 7,
          modelCount: b.models,
          spark: dates.map((d) => b.days.get(d) ?? 0),
          composition: top,
        };
      });
  }, [market, dates]);

  const traces = useMemo(() => {
    if (!market || dates.length === 0 || desks.length === 0) return [];
    const topSlugs = desks.map((d) => d.slug);
    const value = (s: { spendUsd: number | null; tokens: number | null }) => (mode === "spend" ? s.spendUsd : s.tokens) ?? 0;
    const perDay = new Map<string, Map<string, number>>(); // provider -> date -> value
    const others = new Map<string, number>();
    for (const s of market.series) {
      if (!dates.includes(s.bucketDate)) continue;
      if (topSlugs.includes(s.provider)) {
        const m = perDay.get(s.provider) ?? new Map();
        m.set(s.bucketDate, value(s));
        perDay.set(s.provider, m);
      } else {
        others.set(s.bucketDate, (others.get(s.bucketDate) ?? 0) + value(s));
      }
    }
    const out = topSlugs.map((slug, i) => ({
      name: providerLabel(slug),
      x: dates,
      y: dates.map((d) => perDay.get(slug)?.get(d) ?? 0),
      color: MODEL_COLORS[i % MODEL_COLORS.length]!,
    }));
    out.push({ name: "Others", x: dates, y: dates.map((d) => others.get(d) ?? 0), color: "#9aa6b5" });
    return out;
  }, [market, dates, desks, mode]);

  if (error) return <ErrorNote error={error} />;
  if (!market || !stats) return <Loading label="Loading provider market…" />;

  const totalPerDay = desks.reduce((s, d) => s + d.spendPerDay, 0);

  return (
    <>
      <div className="view-head">
        <div>
          <div className="eyebrow">Sell side</div>
          <h2 className="section-title">Who serves the market</h2>
        </div>
        <p className="view-sub">
          Estimated <b>revenue</b> per inference provider: each provider's daily tokens priced at its own
          usage-weighted effective rates (cache discounts included). Head of the market — top 40 models.
        </p>
      </div>

      {/* Revenue tape */}
      <Panel className="chart-card">
        <div className="chart-head">
          <div>
            <div className="chart-title">The revenue tape</div>
            <div className="chart-note mono">
              {mode === "spend" ? "est. $/day" : "tokens/day"} · stacked · top 10 providers + rest · complete days
            </div>
          </div>
          <div className="seg seg-sm">
            <button className={mode === "spend" ? "active" : ""} onClick={() => setMode("spend")}>
              Est. revenue
            </button>
            <button className={mode === "tokens" ? "active" : ""} onClick={() => setMode("tokens")}>
              Tokens
            </button>
          </div>
        </div>
        {traces.length ? <ProviderRevenueChart traces={traces} mode={mode} height={330} /> : <div className="empty">History accumulates daily — check back tomorrow.</div>}
      </Panel>

      {/* Desks */}
      <SectionHead eyebrow="The desks" title="Top 10 providers by est. revenue" />
      <div className="prov-list">
        {desks.map((d, i) => {
          const delta = d.prevSpendPerDay && d.prevSpendPerDay > 0 ? d.spendPerDay / d.prevSpendPerDay - 1 : null;
          return (
            <Panel key={d.slug} className="prov-row">
              <div className="prov-rank mono">{String(i + 1).padStart(2, "0")}</div>
              <div>
                <div className="prov-name">{d.name}</div>
                <div className="prov-meta mono">
                  {d.modelCount} model{d.modelCount === 1 ? "" : "s"} tracked · {compact(d.tokensPerDay)} tok/day ·{" "}
                  {((d.spendPerDay / (totalPerDay || 1)) * 100).toFixed(1)}% of top-10
                </div>
              </div>
              <div className="prov-money">
                <div className="prov-usd mono">{usd(d.spendPerDay)}<span className="prov-usd-unit">/day</span></div>
                {delta !== null ? (
                  <div className={`mono prov-delta ${delta >= 0 ? "up" : "down"}`}>
                    {delta >= 0 ? "▲" : "▼"} {Math.abs(delta * 100).toFixed(1)}% w/w
                  </div>
                ) : (
                  <div className="mono prov-delta" style={{ color: "var(--faint)" }}>building history</div>
                )}
              </div>
              <div className="prov-comp">
                <div className="comp-bar">
                  {d.composition.map((c) => (
                    <span key={c.modelId} className="comp-seg" style={{ width: `${Math.max(1.5, c.share * 100)}%`, background: c.color }} title={`${c.label} · ${(c.share * 100).toFixed(0)}%`} />
                  ))}
                </div>
                <div className="comp-legend mono">
                  {d.composition.map((c) => (
                    <span
                      key={c.modelId}
                      className={c.modelId === "__rest__" ? "" : "comp-link"}
                      onClick={() => c.modelId !== "__rest__" && navigate(`/model/${encodeModelId(c.modelId)}`)}
                    >
                      <i style={{ background: c.color }} /> {c.label} {(c.share * 100).toFixed(0)}%
                    </span>
                  ))}
                </div>
              </div>
              <div className="prov-spark">
                <Sparkline values={d.spark} color={C.gold} width={150} height={38} />
              </div>
            </Panel>
          );
        })}
      </div>
      {desks.length === 0 && <div className="empty" style={{ padding: 30 }}>Provider revenue history builds daily — first desks appear after the next sweep.</div>}

      {/* Price book */}
      <SectionHead eyebrow="Price book" title={`${stats.length} providers quoting`} />
      <PriceBook stats={stats} navigate={navigate} />
    </>
  );
}

type SortKey = "models" | "cheapest" | "avg" | "name";

function PriceBook({ stats, navigate }: { stats: ProviderStat[]; navigate: (to: string) => void }) {
  const [sort, setSort] = useState<SortKey>("models");
  const [dir, setDir] = useState<1 | -1>(-1);

  const rows = useMemo(() => {
    const val = (p: ProviderStat): number | string => {
      switch (sort) {
        case "models": return p.modelCount;
        case "cheapest": return p.cheapestUsdPerMtok ?? 1e9;
        case "avg": return p.avgUsdPerMtok ?? 1e9;
        case "name": return p.provider.toLowerCase();
      }
    };
    return [...stats].sort((a, b) => {
      const va = val(a); const vb = val(b);
      if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb)) * dir;
      return (va - vb) * dir;
    });
  }, [stats, sort, dir]);

  const clickSort = (key: SortKey) => {
    if (sort === key) setDir((d) => (d === 1 ? -1 : 1));
    else { setSort(key); setDir(key === "models" ? -1 : 1); }
  };
  const arrow = (key: SortKey) => (sort === key ? <span className="arrow">{dir === 1 ? "▲" : "▼"}</span> : null);
  const maxModels = Math.max(...stats.map((p) => p.modelCount), 1);

  return (
    <div className="table-wrap">
      <table className="tt">
        <thead>
          <tr>
            <th className="left" onClick={() => clickSort("name")}>Provider {arrow("name")}</th>
            <th onClick={() => clickSort("models")}>Models served {arrow("models")}</th>
            <th onClick={() => clickSort("cheapest")}>Cheapest $/M {arrow("cheapest")}</th>
            <th onClick={() => clickSort("avg")}>Avg $/M {arrow("avg")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.provider} onClick={() => navigate(`/models?q=${encodeURIComponent(p.provider.toLowerCase())}`)}>
              <td className="left" style={{ fontFamily: "var(--font-body)", fontWeight: 500 }}>{p.provider}</td>
              <td>
                <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" }}>
                  <span
                    style={{
                      height: 4,
                      width: `${Math.max(6, (p.modelCount / maxModels) * 90)}px`,
                      background: "linear-gradient(90deg, var(--teal), rgba(14,124,134,0.32))",
                      borderRadius: 2,
                    }}
                  />
                  {p.modelCount}
                </div>
              </td>
              <td className="val-gold">{mtok(p.cheapestUsdPerMtok)}</td>
              <td style={{ color: "var(--muted)" }}>{mtok(p.avgUsdPerMtok)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
