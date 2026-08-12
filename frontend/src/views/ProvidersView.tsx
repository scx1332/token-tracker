import { useEffect, useMemo, useState } from "react";
import { api, type ProviderStat } from "../api";
import { Loading, ErrorNote } from "../components";
import { mtok } from "../format";

type SortKey = "models" | "cheapest" | "avg" | "name";

export function ProvidersView({ navigate }: { navigate: (to: string) => void }) {
  const [providers, setProviders] = useState<ProviderStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("models");
  const [dir, setDir] = useState<1 | -1>(-1);

  useEffect(() => {
    let alive = true;
    api
      .providers()
      .then((r) => alive && setProviders(r.providers))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  const rows = useMemo(() => {
    if (!providers) return [];
    const val = (p: ProviderStat): number | string => {
      switch (sort) {
        case "models": return p.modelCount;
        case "cheapest": return p.cheapestUsdPerMtok ?? 1e9;
        case "avg": return p.avgUsdPerMtok ?? 1e9;
        case "name": return p.provider.toLowerCase();
      }
    };
    return [...providers].sort((a, b) => {
      const va = val(a); const vb = val(b);
      if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb)) * dir;
      return (va - vb) * dir;
    });
  }, [providers, sort, dir]);

  if (error) return <ErrorNote error={error} />;
  if (!providers) return <Loading label="Loading providers…" />;

  const clickSort = (key: SortKey) => {
    if (sort === key) setDir((d) => (d === 1 ? -1 : 1));
    else { setSort(key); setDir(key === "name" || key === "cheapest" || key === "avg" ? 1 : -1); }
  };
  const arrow = (key: SortKey) => (sort === key ? <span className="arrow">{dir === 1 ? "▲" : "▼"}</span> : null);
  const maxModels = Math.max(...providers.map((p) => p.modelCount), 1);

  return (
    <>
      <div className="section-head" style={{ marginTop: 8 }}>
        <div>
          <div className="eyebrow">The counterparties</div>
          <h2 className="section-title">{providers.length} inference providers</h2>
        </div>
        <span className="count-note mono">click a provider to filter models</span>
      </div>

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
              <tr key={p.provider} onClick={() => navigate(`#/models?q=${encodeURIComponent(p.provider.toLowerCase())}`)}>
                <td className="left" style={{ fontFamily: "var(--font-body)", fontWeight: 500 }}>{p.provider}</td>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "flex-end" }}>
                    <span
                      style={{
                        height: 4,
                        width: `${Math.max(6, (p.modelCount / maxModels) * 90)}px`,
                        background: "linear-gradient(90deg, var(--cyan), #2a98a5)",
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
    </>
  );
}
