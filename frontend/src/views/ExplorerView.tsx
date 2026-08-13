import { useEffect, useMemo, useState } from "react";
import { api, type ModelDetail, type ModelWithLatest, type ProviderPricesResponse, type ProviderVolumeResponse } from "../api";
import { Panel, Loading, ErrorNote, Empty, Badge } from "../components";
import { PriceEnvelopeChart, ProviderOrderBookChart, UsageHistoryChart, PROVIDER_COLORS } from "../charts";
import {
  METRIC_LABEL,
  distinctProviders,
  envelopeChange,
  metricPerMtok,
  minEnvelope,
  providerOrderBook,
  seriesForProvider,
  type Metric,
} from "../price";
import { compact, displayName, mtok, perMtok, shortDate, usd } from "../format";
import { isFrontier } from "../frontier";

const RANGES: { label: string; days: number | null }[] = [
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "180D", days: 180 },
  { label: "1Y", days: 365 },
  { label: "All", days: null },
];

export function ExplorerView({
  modelId: initialModel,
  provider: initialProvider,
  navigate,
}: {
  modelId?: string;
  provider?: string;
  navigate: (to: string) => void;
}) {
  const [models, setModels] = useState<ModelWithLatest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [modelId, setModelId] = useState<string | null>(initialModel ?? null);
  // Multi-select: each pinned provider gets its own line. Empty = min across all.
  const [selected, setSelected] = useState<string[]>(
    initialProvider ? initialProvider.split(",").map((s) => s.trim()).filter(Boolean) : [],
  );
  const [metric, setMetric] = useState<Metric>("blended");
  const [days, setDays] = useState<number | null>(null);

  const [priceData, setPriceData] = useState<ProviderPricesResponse | null>(null);
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [volume, setVolume] = useState<ProviderVolumeResponse | null>(null);
  const [bookMode, setBookMode] = useState<"price" | "tokens" | "spend">("price");
  const [loadingModel, setLoadingModel] = useState(false);

  // Load the model universe once; pick a sensible default (highest-spend priced model).
  useEffect(() => {
    let alive = true;
    api
      .models({ limit: 5000 })
      .then((r) => {
        if (!alive) return;
        setModels(r.models);
        if (!initialModel) {
          const priced = r.models.filter((m) => (m.providerCount ?? 0) > 0 && !m.isFree);
          const pick = (priced.length ? priced : r.models).sort((a, b) => (b.latestSpendUsd ?? 0) - (a.latestSpendUsd ?? 0))[0];
          if (pick) setModelId(pick.modelId);
        }
      })
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [initialModel]);

  // Load the selected model's per-provider price history + usage/detail.
  useEffect(() => {
    if (!modelId) return;
    let alive = true;
    setLoadingModel(true);
    setPriceData(null);
    setDetail(null);
    setVolume(null);
    // Live traffic is best-effort — the explorer works without it.
    api
      .providerVolume(modelId)
      .then((v) => alive && setVolume(v))
      .catch(() => {});
    Promise.all([api.providerPrices(modelId, 365), api.model(modelId, 180)])
      .then(([pp, d]) => {
        if (!alive) return;
        setPriceData(pp);
        setDetail(d);
        // Drop pinned providers that don't serve this model.
        setSelected((cur) => cur.filter((p) => pp.providers.includes(p)));
      })
      .catch((e) => alive && setError(String(e.message ?? e)))
      .finally(() => alive && setLoadingModel(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  // Keep the URL shareable without remounting the view.
  useEffect(() => {
    if (!modelId) return;
    const q = selected.length ? `?provider=${selected.map(encodeURIComponent).join(",")}` : "";
    const target = `#/explorer/${encodeURIComponent(modelId)}${q}`;
    if (window.location.hash !== target) window.history.replaceState(null, "", target);
  }, [modelId, selected]);

  const toggleProvider = (p: string) =>
    setSelected((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  const points = priceData?.points ?? [];
  const rangedPoints = useMemo(() => {
    if (days == null) return points;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return points.filter((p) => p.observedAt >= since);
  }, [points, days]);

  const allProviders = useMemo(() => distinctProviders(points), [points]);
  const orderBook = useMemo(() => providerOrderBook(points, metric), [points, metric]);

  // Per-provider volume estimate: OpenRouter only publishes request counts
  // (trailing ~30 min), so tokens/day = request share × the model's daily
  // tokens, and $/day prices those tokens at the provider's own quote using
  // the model's observed prompt/completion mix.
  const volumeRows = useMemo(() => {
    if (!volume?.providers.length) return [];
    const totalReq = volume.providers.reduce((s, p) => s + p.requestCount, 0);
    if (totalReq <= 0) return [];
    const dayTokens = detail?.usage.at(-1)?.tokens ?? null;
    const mix = [...(detail?.usage ?? [])]
      .reverse()
      .find((r) => r.promptTokens != null && r.completionTokens != null && r.promptTokens + r.completionTokens > 0);
    const promptShare = mix ? mix.promptTokens! / (mix.promptTokens! + mix.completionTokens!) : 0.5;
    // The stats feed uses display names ("NovitaAI", "Baidu Qianfan") where the
    // pricing API uses short names ("Novita", "Baidu") — join on a normalized
    // prefix match so quotes and traffic line up.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const book = orderBook.map((q) => ({ q, n: norm(q.provider) }));
    const findQuote = (name: string) => {
      const n = norm(name);
      return (book.find((b) => b.n === n) ?? book.find((b) => b.n.startsWith(n) || n.startsWith(b.n)))?.q ?? null;
    };
    // Several stats-side names can resolve to one pricing-side provider —
    // aggregate after the join or Plotly merges duplicate categories.
    const agg = new Map<string, { provider: string; share: number; tokens: number | null; spendUsd: number | null }>();
    for (const v of volume.providers) {
      const share = v.requestCount / totalReq;
      const tokens = dayTokens != null ? share * dayTokens : null;
      const quote = findQuote(v.provider);
      const perTok = quote ? (quote.row.promptUsd ?? 0) * promptShare + (quote.row.completionUsd ?? 0) * (1 - promptShare) : null;
      // Use the pricing-side name so chip pinning and bar colors line up.
      const name = quote?.provider ?? v.provider;
      const cur = agg.get(name) ?? { provider: name, share: 0, tokens: null, spendUsd: null };
      cur.share += share;
      if (tokens != null) cur.tokens = (cur.tokens ?? 0) + tokens;
      if (tokens != null && perTok != null) cur.spendUsd = (cur.spendUsd ?? 0) + tokens * perTok;
      agg.set(name, cur);
    }
    return [...agg.values()];
  }, [volume, detail, orderBook]);
  const volumeByProvider = useMemo(
    () => new Map(volumeRows.map((r) => [r.provider.toLowerCase(), r])),
    [volumeRows],
  );

  // Providers under 1% of live traffic are noise — hide them everywhere
  // (pinned ones always stay; no traffic data → show everything).
  const activeSet = useMemo(() => {
    if (!volumeRows.length) return null;
    return new Set(volumeRows.filter((r) => r.share >= 0.01).map((r) => r.provider.toLowerCase()));
  }, [volumeRows]);
  const isShown = (p: string) => !activeSet || activeSet.has(p.toLowerCase()) || selected.includes(p);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const providers = useMemo(() => allProviders.filter(isShown), [allProviders, activeSet, selected]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shownBook = useMemo(() => orderBook.filter((q) => isShown(q.provider)), [orderBook, activeSet, selected]);
  const shownPoints = useMemo(
    () => (activeSet ? rangedPoints.filter((p) => isShown(p.provider)) : rangedPoints),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rangedPoints, activeSet, selected],
  );

  const envelope = useMemo(() => minEnvelope(shownPoints, metric), [shownPoints, metric]);

  // A quote holds until it changes, so carry the latest values forward to "now"
  // for the chart — a single observation reads as a held-price line, not a dot.
  const chartEnv = useMemo(() => {
    if (envelope.length === 0) return envelope;
    const now = new Date().toISOString();
    const last = envelope[envelope.length - 1]!;
    return last.date >= now ? envelope : [...envelope, { ...last, date: now }];
  }, [envelope]);

  const providerLines = useMemo(() => {
    const now = new Date().toISOString();
    const lines: { name: string; x: string[]; y: (number | null)[]; color: string }[] = [];
    selected.forEach((name, i) => {
      const rows = seriesForProvider(rangedPoints, name);
      if (!rows.length) return;
      const x = rows.map((r) => r.observedAt);
      const y = rows.map((r) => metricPerMtok(r, metric));
      if (x[x.length - 1]! < now) {
        x.push(now);
        y.push(y[y.length - 1]!);
      }
      lines.push({ name, x, y, color: PROVIDER_COLORS[i % PROVIDER_COLORS.length]! });
    });
    return lines;
  }, [rangedPoints, selected, metric]);

  const latest = envelope[envelope.length - 1] ?? null;
  const minNow = latest?.min ?? null;
  const cheapestNow = latest?.cheapest ?? null;
  const spreadNow = latest && latest.min != null && latest.max != null ? latest.max - latest.min : null;
  const change = envelopeChange(envelope, "min");
  const selectedQuote = selected.length === 1 ? orderBook.find((q) => q.provider === selected[0]) ?? null : null;

  const model = detail?.model ?? models?.find((m) => m.modelId === modelId) ?? null;

  if (error) return <ErrorNote error={error} />;
  if (!models) return <Loading label="Loading model universe…" />;

  const x = chartEnv.map((e) => e.date);
  const enoughForSlider = envelope.length >= 4;

  return (
    <>
      <div className="view-head">
        <div>
          <div className="eyebrow">Price explorer</div>
          <h2 className="section-title">Follow a model's price across every provider</h2>
        </div>
        <p className="view-sub">
          Track the <b>minimum</b> price for any model over time and compare the companies serving it. The bold line is
          the cheapest provider; the band is the full spread from cheapest to dearest.
        </p>
      </div>

      {/* Control bar */}
      <Panel className="explorer-controls">
        <div className="ctl ctl-wide">
          <label className="ctl-label">Model — top spenders &amp; biggest token movers</label>
          <ModelChips models={models} value={modelId} onChange={setModelId} />
        </div>
        <div className="ctl ctl-wide">
          <label className="ctl-label">Providers — pick any number, each gets its own line</label>
          <div className="chip-row">
            <button className={`chip${selected.length === 0 ? " active" : ""}`} onClick={() => setSelected([])}>
              All · minimum
            </button>
            {providers.map((p) => {
              const idx = selected.indexOf(p);
              const color = idx >= 0 ? PROVIDER_COLORS[idx % PROVIDER_COLORS.length] : undefined;
              return (
                <button
                  key={p}
                  className={`chip${idx >= 0 ? " active" : ""}`}
                  style={color ? { borderColor: color, color } : undefined}
                  onClick={() => toggleProvider(p)}
                >
                  {p}
                </button>
              );
            })}
          </div>
        </div>
        <div className="ctl">
          <label className="ctl-label">Price</label>
          <div className="seg">
            {(["blended", "input", "output"] as Metric[]).map((m) => (
              <button key={m} className={metric === m ? "active" : ""} onClick={() => setMetric(m)}>
                {m === "blended" ? "Blend" : m === "input" ? "Input" : "Output"}
              </button>
            ))}
          </div>
        </div>
        <div className="ctl">
          <label className="ctl-label">Range</label>
          <div className="seg">
            {RANGES.map((r) => (
              <button key={r.label} className={days === r.days ? "active" : ""} onClick={() => setDays(r.days)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </Panel>

      {/* Headline stat strip */}
      <div className="explorer-stats">
        <StatBox label={`Minimum ${METRIC_LABEL[metric].toLowerCase()}`} value={minNow == null ? "—" : mtok(minNow)} accent="min" foot={cheapestNow ? `cheapest · ${cheapestNow}` : "no priced provider"} />
        <StatBox
          label={selected.length > 1 ? "Providers compared" : "Selected provider"}
          value={
            selected.length === 0
              ? "All"
              : selected.length === 1
                ? selectedQuote?.value == null
                  ? "—"
                  : mtok(selectedQuote.value)
                : String(selected.length)
          }
          foot={selected.length === 0 ? "showing the floor" : selected.length === 1 ? selected[0]! : selected.join(" · ")}
          accent="teal"
        />
        <StatBox
          label={activeSet ? "Providers used" : "Providers serving"}
          value={String(shownBook.filter((q) => q.value != null).length || providers.length)}
          foot={`${spreadNow != null ? `spread ${mtok(spreadNow)}` : "single quote"}${activeSet ? ` · ${"\u2265"}1% of traffic` : ""}`}
        />
        <StatBox
          label="Min change · window"
          value={change == null ? "—" : `${change > 0 ? "+" : ""}${(change * 100).toFixed(1)}%`}
          accent={change == null ? undefined : change < 0 ? "down" : "up"}
          foot={change == null ? "history builds hourly" : days == null ? "all history" : `last ${days}d`}
        />
      </div>

      {/* Main chart */}
      <Panel className="chart-card explorer-main">
        <div className="chart-head">
          <div>
            <div className="chart-title">
              {model ? displayName(model.name) : modelId} · price history
              {model && isFrontier(model.modelId) && <Badge kind="frontier">frontier</Badge>}
            </div>
            <div className="chart-note mono">
              {METRIC_LABEL[metric]} ·{" "}
              {selected.length === 0
                ? "minimum across providers"
                : `min vs ${selected.length <= 2 ? selected.join(", ") : `${selected.length} providers`}`}
            </div>
          </div>
          {model && (
            <a
              className="ghost-link"
              href={`#/model/${encodeURIComponent(model.modelId)}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(`#/model/${encodeURIComponent(model.modelId)}`);
              }}
            >
              Model details →
            </a>
          )}
        </div>
        {loadingModel ? (
          <Loading label="Loading price history…" />
        ) : envelope.length ? (
          <>
            <PriceEnvelopeChart
              x={x}
              min={chartEnv.map((e) => e.min)}
              max={chartEnv.map((e) => e.max)}
              cheapest={chartEnv.map((e) => e.cheapest)}
              providers={providerLines}
              metricLabel={METRIC_LABEL[metric]}
              height={400}
              rangeslider={enoughForSlider}
            />
            {envelope.length < 2 && (
              <div className="inline-note mono">
                Only one price observation so far — the line fills in as prices change. The cross-provider spread below is
                live now.
              </div>
            )}
          </>
        ) : (
          <Empty label="No per-provider pricing captured for this model yet." />
        )}
      </Panel>

      {/* Order book + usage */}
      <div className="grid explorer-lower">
        <Panel className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">Provider order book · now</div>
              <div className="chart-note mono">
                {bookMode === "price"
                  ? `latest ${METRIC_LABEL[metric].toLowerCase()} · cheapest first · click to pin`
                  : bookMode === "tokens"
                    ? `est. tokens/day · request share (last ~${volume?.windowMinutes ?? 30} min) × daily tokens`
                    : "est. $/day · provider tokens priced at its own quote"}
              </div>
            </div>
            <div className="seg seg-sm">
              {(["price", "tokens", "spend"] as const).map((m) => (
                <button key={m} className={bookMode === m ? "active" : ""} onClick={() => setBookMode(m)}>
                  {m === "price" ? "Price" : m === "tokens" ? "Tokens" : "Est. spend"}
                </button>
              ))}
            </div>
          </div>
          {bookMode === "price" ? (
            shownBook.some((q) => q.value != null) ? (
              <ProviderOrderBookChart quotes={shownBook} selected={selected} onPick={toggleProvider} kind="price" />
            ) : (
              <Empty label="No provider quotes yet." />
            )
          ) : volumeRows.length ? (
            <ProviderOrderBookChart
              quotes={volumeRows
                .filter((r) => r.share >= 0.01 || selected.includes(r.provider))
                .map((r) => ({ provider: r.provider, value: bookMode === "tokens" ? r.tokens : r.spendUsd }))
                .filter((q) => q.value != null)
                .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))}
              selected={selected}
              onPick={toggleProvider}
              kind={bookMode}
            />
          ) : (
            <Empty label="No live traffic data from OpenRouter for this model." />
          )}
        </Panel>
        <Panel className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">Model usage &amp; estimated spend</div>
              <div className="chart-note mono">daily est. spend (amber) · tokens (teal)</div>
            </div>
          </div>
          {detail && detail.usage.length > 1 ? (
            <UsageHistoryChart rows={detail.usage} height={Math.max(220, shownBook.length * 26 - 20)} />
          ) : (
            <Empty label="No usage history for this model yet." />
          )}
        </Panel>
      </div>

      {/* Order-book table */}
      {shownBook.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table className="tt">
            <thead>
              <tr>
                <th className="left">Provider</th>
                <th>{METRIC_LABEL[metric]}</th>
                <th>Input $/M</th>
                <th>Output $/M</th>
                <th>Traffic</th>
                <th>Est. tok/day</th>
                <th>Est. $/day</th>
                <th>Context</th>
                <th>Quant</th>
                <th>As of</th>
              </tr>
            </thead>
            <tbody>
              {shownBook.map((q, i) => (
                <tr
                  key={q.provider}
                  className={selected.includes(q.provider) ? "row-sel" : ""}
                  onClick={() => toggleProvider(q.provider)}
                >
                  <td className="left" style={{ fontFamily: "var(--font-body)", fontWeight: 500 }}>
                    {q.provider}
                    {i === 0 && <Badge kind="free">cheapest</Badge>}
                    {selected.includes(q.provider) && <Badge kind="ghost">pinned</Badge>}
                  </td>
                  <td className="val-min" style={{ fontWeight: 600 }}>{q.row.isFree ? "$0" : mtok(q.value)}</td>
                  <td>{q.row.isFree ? "$0" : perMtok(q.row.promptUsd)}</td>
                  <td>{q.row.isFree ? "$0" : perMtok(q.row.completionUsd)}</td>
                  {(() => {
                    const v = volumeByProvider.get(q.provider.toLowerCase());
                    return (
                      <>
                        <td style={{ color: "var(--muted)" }}>{v ? `${(v.share * 100).toFixed(1)}%` : "—"}</td>
                        <td style={{ color: "var(--muted)" }}>{v?.tokens != null ? compact(v.tokens) : "—"}</td>
                        <td className="val-gold">{v?.spendUsd != null ? usd(v.spendUsd) : "—"}</td>
                      </>
                    );
                  })()}
                  <td style={{ color: "var(--muted)" }}>{q.row.contextLength ? compact(q.row.contextLength, 0) : "—"}</td>
                  <td style={{ color: "var(--muted)" }}>{q.row.quantization ?? "—"}</td>
                  <td style={{ color: "var(--faint)" }}>{shortDate(q.row.observedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="explorer-foot mono">
        {model && (
          <>
            {usd(detail?.usage.at(-1)?.estimatedSpendUsd ?? model.latestSpendUsd)} est. spend/day ·{" "}
            {compact(detail?.usage.at(-1)?.tokens ?? model.latestTokens)} tokens/day · price history accumulates every hour
          </>
        )}
      </div>
    </>
  );
}

function StatBox({
  label,
  value,
  foot,
  accent,
}: {
  label: string;
  value: string;
  foot?: string;
  accent?: "min" | "teal" | "up" | "down";
}) {
  return (
    <div className="statbox">
      <div className="statbox-label">{label}</div>
      <div className={`statbox-value mono${accent ? ` val-${accent}` : ""}`}>{value}</div>
      {foot && <div className="statbox-foot mono">{foot}</div>}
    </div>
  );
}

/**
 * The models that actually matter: top 10 by est. daily spend ∪ top 10 by
 * daily tokens (paid, priced models only), deduped by family so dated
 * revisions don't eat two slots. Spend leaders rank first.
 */
function importantModels(models: ModelWithLatest[]): ModelWithLatest[] {
  const eligible = models.filter((m) => !m.isFree && (m.providerCount ?? 0) > 0);
  const family = (m: ModelWithLatest) => m.modelId.replace(/-\d{4}$/, "");
  const bySpend = [...eligible].sort((a, b) => (b.latestSpendUsd ?? 0) - (a.latestSpendUsd ?? 0)).slice(0, 10);
  const byTokens = [...eligible].sort((a, b) => (b.latestTokens ?? 0) - (a.latestTokens ?? 0)).slice(0, 10);
  const seen = new Set<string>();
  const out: ModelWithLatest[] = [];
  for (const m of [...bySpend, ...byTokens]) {
    const k = family(m);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out.sort((a, b) => (b.latestSpendUsd ?? 0) - (a.latestSpendUsd ?? 0));
}

function ModelChips({
  models,
  value,
  onChange,
}: {
  models: ModelWithLatest[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  const chips = useMemo(() => {
    const top = importantModels(models);
    // A deep-linked model outside the top set still gets a chip while selected.
    if (value && !top.some((m) => m.modelId === value)) {
      const current = models.find((m) => m.modelId === value);
      if (current) top.push(current);
    }
    return top;
  }, [models, value]);

  return (
    <div className="chip-row">
      {chips.map((m) => (
        <button
          key={m.modelId}
          className={`chip${m.modelId === value ? " active" : ""}`}
          title={`${m.modelId} · ${usd(m.latestSpendUsd)}/day`}
          onClick={() => onChange(m.modelId)}
        >
          {displayName(m.name)}
        </button>
      ))}
    </div>
  );
}
