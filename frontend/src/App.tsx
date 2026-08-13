import { useEffect, useState } from "react";
import { api, type HealthResponse } from "./api";
import { Stat } from "./components";
import { compact, relTime } from "./format";
import { MarketView } from "./views/MarketView";
import { ExplorerView } from "./views/ExplorerView";
import { ModelsView } from "./views/ModelsView";
import { ModelView } from "./views/ModelView";
import { ProvidersView } from "./views/ProvidersView";

function useHashRoute(): [string, (to: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash || "#/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = (to: string) => {
    window.location.hash = to;
  };
  return [hash, navigate];
}

export function App() {
  const [hash, navigate] = useHashRoute();
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => alive && setHealth(h))
      .catch(() => setHealth(null));
    return () => {
      alive = false;
    };
  }, []);

  const route = parseRoute(hash);

  const navItems: { key: string; label: string; to: string }[] = [
    { key: "market", label: "Market", to: "#/" },
    { key: "explorer", label: "Price Explorer", to: "#/explorer" },
    { key: "models", label: "Models", to: "#/models" },
    { key: "providers", label: "Providers", to: "#/providers" },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/">
            <span className="brand-mark" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 32 32">
                <path d="M4 22 L12 15 L18 19 L28 8" fill="none" stroke="#2b34cc" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="28" cy="8" r="2.6" fill="#b06a06" />
              </svg>
            </span>
            <span className="brand-name">
              Token<span className="brand-em">Exchange</span>
            </span>
          </a>
          <nav className="nav">
            {navItems.map((n) => (
              <a key={n.key} href={n.to} className={route.name === n.key ? "active" : ""}>
                {n.label}
              </a>
            ))}
          </nav>
          <div className="statusline">
            <Stat k="models" v={health ? health.models.total : "—"} />
            <Stat k="price pts" v={health ? compact(health.coverage.pricePoints, 0) : "—"} />
            <Stat k="synced" v={health ? relTime(health.coverage.lastUsageCapturedAt) : "—"} />
          </div>
        </div>
      </header>

      <main className="container">
        {route.name === "market" && <MarketView navigate={navigate} />}
        {route.name === "explorer" && <ExplorerView modelId={route.id} provider={route.provider} navigate={navigate} />}
        {route.name === "models" && <ModelsView navigate={navigate} />}
        {route.name === "providers" && <ProvidersView navigate={navigate} />}
        {route.name === "model" && <ModelView modelId={route.id} navigate={navigate} />}
      </main>

      <footer className="footer">
        <div>
          Estimated figures derived from public OpenRouter data, refreshed hourly. Spend is an estimate (tokens × observed effective rates, incl. cache discounts),
          not billed revenue; per-provider price history accumulates going forward.
        </div>
        <div style={{ marginTop: 6 }}>
          <a href="https://github.com/scx1332/token-tracker" target="_blank" rel="noreferrer">
            github.com/scx1332/token-tracker
          </a>
        </div>
      </footer>
    </div>
  );
}

type Route =
  | { name: "market" }
  | { name: "explorer"; id?: string; provider?: string }
  | { name: "models" }
  | { name: "providers" }
  | { name: "model"; id: string };

function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const path = pathPart ?? "";
  const query = new URLSearchParams(queryPart ?? "");
  if (path.startsWith("model/")) {
    return { name: "model", id: decodeURIComponent(path.slice("model/".length)) };
  }
  if (path.startsWith("explorer")) {
    const rest = path.slice("explorer".length).replace(/^\//, "");
    const route: Route = { name: "explorer" };
    if (rest) route.id = decodeURIComponent(rest);
    const provider = query.get("provider");
    if (provider) route.provider = provider;
    return route;
  }
  if (path.startsWith("models")) return { name: "models" };
  if (path.startsWith("providers")) return { name: "providers" };
  return { name: "market" };
}
