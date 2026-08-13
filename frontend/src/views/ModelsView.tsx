import { useEffect, useMemo, useState } from "react";
import { api, type ModelWithLatest } from "../api";
import { Badge, Loading, ErrorNote } from "../components";
import { perMtok, compact, usd, displayName } from "../format";
import { isFrontier } from "../frontier";

type SortKey = "tokens" | "spend" | "input" | "output" | "providers" | "name";

function initialQuery(): string {
  const m = window.location.hash.match(/[?&]q=([^&]+)/);
  return m ? decodeURIComponent(m[1]!) : "";
}

export function ModelsView({ navigate }: { navigate: (to: string) => void }) {
  const [models, setModels] = useState<ModelWithLatest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [onlyPaid, setOnlyPaid] = useState(false);
  const [onlyFrontier, setOnlyFrontier] = useState(false);
  const [sort, setSort] = useState<SortKey>("spend");
  const [dir, setDir] = useState<1 | -1>(-1);

  useEffect(() => {
    let alive = true;
    api
      .models({ limit: 5000 })
      .then((r) => alive && setModels(r.models))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  const rows = useMemo(() => {
    if (!models) return [];
    const q = query.trim().toLowerCase();
    let list = models.filter((m) => {
      if (onlyPaid && m.isFree) return false;
      if (onlyFrontier && !isFrontier(m.modelId)) return false;
      if (!q) return true;
      return m.modelId.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.author.toLowerCase().includes(q);
    });
    const val = (m: ModelWithLatest): number | string => {
      switch (sort) {
        case "tokens": return m.latestTokens ?? -1;
        case "spend": return m.latestSpendUsd ?? -1;
        case "input": return m.promptUsd ?? -1;
        case "output": return m.completionUsd ?? -1;
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
  }, [models, query, onlyPaid, onlyFrontier, sort, dir]);

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
        <span className="count-note mono">{rows.length} models</span>
      </div>

      <div className="table-wrap">
        <table className="tt">
          <thead>
            <tr>
              <th className="left" onClick={() => clickSort("name")}>Model {arrow("name")}</th>
              <th onClick={() => clickSort("input")}>Input $/M {arrow("input")}</th>
              <th onClick={() => clickSort("output")}>Output $/M {arrow("output")}</th>
              <th onClick={() => clickSort("spend")}>Est. spend/day {arrow("spend")}</th>
              <th onClick={() => clickSort("tokens")}>Daily tokens {arrow("tokens")}</th>
              <th onClick={() => clickSort("providers")}>Providers {arrow("providers")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 600).map((m) => (
              <tr key={m.modelId} onClick={() => navigate(`#/model/${encodeURIComponent(m.modelId)}`)}>
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
                <td className="val-gold">{usd(m.latestSpendUsd)}</td>
                <td>{compact(m.latestTokens)}</td>
                <td style={{ color: "var(--muted)" }}>{m.providerCount || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 600 && (
        <div className="count-note mono" style={{ marginTop: 10 }}>
          Showing top 600 of {rows.length}. Refine with search.
        </div>
      )}
      <div style={{ height: 8 }} />
      <span className="count-note mono" style={{ display: "block" }}>Prices shown per 1M tokens · click a row for full history</span>
    </>
  );
}
