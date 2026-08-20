import { encodeModelId } from "../routes";
import { useEffect, useMemo, useState } from "react";
import { api, type ModelWithLatest, type ProviderStat } from "../api";
import { Badge, Loading, ErrorNote, Empty } from "../components";
import { perMtok, compact, usd, displayName } from "../format";
import { isFrontier } from "../frontier";

type SortKey = "tokens" | "spend" | "input" | "output" | "effective" | "released" | "providers" | "name";

/** Release cutoff for the default view: models older than this are noise. */
const RECENT_MONTHS = 12;

/** Traffic floor for the default view: under 100M tokens/day nobody's really using it. */
const MIN_DAILY_TOKENS = 100_000_000;

/**
 * Realized blended price per token: what a routed token actually cost
 * (est. spend ÷ tokens), embedding the prompt/completion mix and cache
 * discounts — often well under the list prices beside it.
 */
function effectivePerTok(m: ModelWithLatest): number | null {
  if (!m.latestSpendUsd || !m.latestTokens) return null;
  return m.latestSpendUsd / m.latestTokens;
}

function releasedMs(m: ModelWithLatest): number | null {
  if (!m.createdOr) return null;
  const t = Date.parse(m.createdOr);
  return Number.isFinite(t) ? t : null;
}

export function ModelsView({
  query: routeQuery,
  provider,
  navigate,
}: {
  query?: string;
  provider?: string;
  navigate: (to: string) => void;
}) {
  const [models, setModels] = useState<ModelWithLatest[] | null>(null);
  const [providers, setProviders] = useState<ProviderStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(routeQuery ?? "");
  const [onlyPaid, setOnlyPaid] = useState(false);
  // Pinning a provider is already a narrow slice, and most of what a host
  // serves is neither frontier nor busy — leaving the noise filters on would
  // hand back an empty board, so a provider link starts with them off.
  const [onlyFrontier, setOnlyFrontier] = useState(!provider);
  const [onlyRecent, setOnlyRecent] = useState(!provider);
  const [onlyActive, setOnlyActive] = useState(!provider);
  const [sort, setSort] = useState<SortKey>("spend");
  const [dir, setDir] = useState<1 | -1>(-1);

  useEffect(() => {
    let alive = true;
    const params: { limit: number; provider?: string } = { limit: 5000 };
    if (provider) params.provider = provider;
    api
      .models(params)
      .then((r) => alive && setModels(r.models))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [provider]);

  // Only powers the "that's a provider, not a model" hint below — a failure
  // costs the hint, not the board.
  useEffect(() => {
    let alive = true;
    api
      .providers()
      .then((r) => alive && setProviders(r.providers))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const rows = useMemo(() => {
    if (!models) return [];
    const q = query.trim().toLowerCase();
    const recentCutoff = Date.now() - RECENT_MONTHS * 30.44 * 86_400_000;
    let list = models.filter((m) => {
      if (onlyPaid && m.isFree) return false;
      if (onlyFrontier && !isFrontier(m.modelId)) return false;
      // Unknown release date fails the recency filter — the toggle shows them.
      const rel = releasedMs(m);
      if (onlyRecent && (rel === null || rel < recentCutoff)) return false;
      // No usage data counts as no traffic — the toggle shows those too.
      if (onlyActive && (m.latestTokens ?? 0) < MIN_DAILY_TOKENS) return false;
      if (!q) return true;
      return m.modelId.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.author.toLowerCase().includes(q);
    });
    const val = (m: ModelWithLatest): number | string => {
      switch (sort) {
        case "tokens": return m.latestTokens ?? -1;
        case "spend": return m.latestSpendUsd ?? -1;
        case "input": return m.promptUsd ?? -1;
        case "output": return m.completionUsd ?? -1;
        case "effective": return effectivePerTok(m) ?? -1;
        case "released": return releasedMs(m) ?? 0;
        case "providers": return m.providerCount ?? 0;
        case "name": return m.name.toLowerCase();
      }
    };
    list = [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb)) * dir;
      return (va - vb) * dir;
    });
    return list;
  }, [models, query, onlyPaid, onlyFrontier, onlyRecent, onlyActive, sort, dir]);

  // "nebius" is a provider, not a model, so the model search comes back empty.
  // Rather than leave that as a dead end, offer the board that does exist.
  const providerHint = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (provider || !providers || !q) return null;
    return providers.find((p) => p.provider.toLowerCase() === q) ?? null;
  }, [provider, providers, query]);

  if (error) return <ErrorNote error={error} />;
  if (!models) return <Loading label="Loading model book…" />;

  const clickSort = (key: SortKey) => {
    if (sort === key) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSort(key);
      setDir(key === "name" ? 1 : -1);
    }
  };
  const arrow = (key: SortKey) => (sort === key ? <span className="arrow">{dir === 1 ? "▲" : "▼"}</span> : null);

  return (
    <>
      <div className="section-head" style={{ marginTop: 8 }}>
        <div>
          <div className="eyebrow">The book</div>
          <h2 className="section-title">Every model, priced</h2>
        </div>
      </div>

      <div className="controls">
        <input
          className="input"
          placeholder="Search model, author…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="seg">
          <button className={!onlyPaid ? "active" : ""} onClick={() => setOnlyPaid(false)}>All</button>
          <button className={onlyPaid ? "active" : ""} onClick={() => setOnlyPaid(true)}>Paid only</button>
        </div>
        <div className="seg">
          <button className={!onlyFrontier ? "active" : ""} onClick={() => setOnlyFrontier(false)}>Every model</button>
          <button className={onlyFrontier ? "active" : ""} onClick={() => setOnlyFrontier(true)}>Frontier</button>
        </div>
        <div className="seg">
          <button className={onlyRecent ? "active" : ""} onClick={() => setOnlyRecent(true)}>Last {RECENT_MONTHS} mo</button>
          <button className={!onlyRecent ? "active" : ""} onClick={() => setOnlyRecent(false)}>All ages</button>
        </div>
        <div className="seg">
          <button className={onlyActive ? "active" : ""} onClick={() => setOnlyActive(true)} title="At least 100M tokens routed per day">
            ≥100M tok/day
          </button>
          <button className={!onlyActive ? "active" : ""} onClick={() => setOnlyActive(false)}>Any traffic</button>
        </div>
        <span className="count-note mono">{rows.length} models</span>
      </div>

      {(provider || providerHint) && (
        <div className="chip-row" style={{ marginBottom: 12 }}>
          {provider && (
            <button className="chip active" onClick={() => navigate("/models")} title="Clear the provider filter">
              Served by {provider} ×
            </button>
          )}
          {providerHint && (
            <button
              className="chip"
              onClick={() => navigate(`/models?provider=${encodeURIComponent(providerHint.provider)}`)}
            >
              {providerHint.provider} is a provider, not a model — show the {providerHint.modelCount} models it serves →
            </button>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <Empty
          label={
            provider
              ? `No models served by ${provider} match these filters.`
              : "No models match this search and filter set."
          }
        />
      ) : (
      <div className="table-wrap">
        <table className="tt">
          <thead>
            <tr>
              <th className="left" onClick={() => clickSort("name")}>Model {arrow("name")}</th>
              <th onClick={() => clickSort("input")}>Input $/M {arrow("input")}</th>
              <th onClick={() => clickSort("output")}>Output $/M {arrow("output")}</th>
              <th onClick={() => clickSort("effective")} title="Realized blended price: est. spend ÷ tokens routed, cache discounts included">
                Eff. $/M {arrow("effective")}
              </th>
              <th onClick={() => clickSort("spend")}>Est. spend/day {arrow("spend")}</th>
              <th onClick={() => clickSort("tokens")}>Daily tokens {arrow("tokens")}</th>
              <th onClick={() => clickSort("released")}>Released {arrow("released")}</th>
              <th onClick={() => clickSort("providers")}>Providers {arrow("providers")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 600).map((m) => (
              <tr key={m.modelId} onClick={() => navigate(`/model/${encodeModelId(m.modelId)}`)}>
                <td className="left">
                  <div className="model-cell">
                    <span className="model-name">
                      {displayName(m.name)}
                      {isFrontier(m.modelId) && <Badge kind="frontier">frontier</Badge>}
                      {m.isFree && <Badge kind="free">free</Badge>}
                      {m.promotionText && <Badge kind="promo">promo</Badge>}
                    </span>
                    <span className="model-id">{m.modelId}</span>
                  </div>
                </td>
                <td className="val-cyan">{m.isFree ? "$0" : perMtok(m.promptUsd)}</td>
                <td className="val-gold">{m.isFree ? "$0" : perMtok(m.completionUsd)}</td>
                <td className="val-gold">{m.isFree ? "$0" : perMtok(effectivePerTok(m))}</td>
                <td className="val-gold">{usd(m.latestSpendUsd)}</td>
                <td>{compact(m.latestTokens)}</td>
                <td style={{ color: "var(--muted)" }}>{m.createdOr ? m.createdOr.slice(0, 7) : "—"}</td>
                <td style={{ color: "var(--muted)" }}>{m.providerCount || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
      {rows.length > 600 && (
        <div className="count-note mono" style={{ marginTop: 10 }}>
          Showing top 600 of {rows.length}. Refine with search.
        </div>
      )}
      <div style={{ height: 8 }} />
      <span className="count-note mono" style={{ display: "block" }}>
        Prices shown per 1M tokens · Eff. $/M = realized est. spend ÷ tokens routed (prompt/completion mix + cache
        discounts) · click a row for full history
      </span>
    </>
  );
}
