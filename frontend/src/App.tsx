import { useEffect, useState } from "react";
import { api, type ModelWithLatest } from "./api";
import { Ticker, type TickerItem } from "./components";
import { perMtok, displayName } from "./format";
import { MarketView } from "./views/MarketView";
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

function blendedPerMtok(m: ModelWithLatest): number | null {
  if (m.promptUsd === null && m.completionUsd === null) return null;
  return (m.promptUsd ?? m.completionUsd ?? 0) * 0.5 + (m.completionUsd ?? m.promptUsd ?? 0) * 0.5;
}

export function App() {
  const [hash, navigate] = useHashRoute();
  const [ticker, setTicker] = useState<TickerItem[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .featured(18)
      .then((r) => {
        if (!alive) return;
        const items: TickerItem[] = r.models
          .filter((m) => m.latestTokens && m.latestTokens > 0)
          .slice(0, 16)
          .map((m) => ({
            sym: displayName(m.name).toUpperCase().slice(0, 22),
            price: m.isFree ? "$0" : perMtok(blendedPerMtok(m)),
            volume: m.latestTokens,
            free: m.isFree,
          }));
        setTicker(items);
      })
      .catch(() => setTicker([]));
    return () => {
      alive = false;
    };
  }, []);

  const route = parseRoute(hash);

  const navItems: { key: string; label: string; to: string }[] = [
    { key: "market", label: "Market", to: "#/" },
    { key: "models", label: "Models", to: "#/models" },
    { key: "providers", label: "Providers", to: "#/providers" },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/">
            <span className="brand-mark">
              <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
                <path d="M4 21 L11 14 L16 18 L27 7" fill="none" stroke="#3FD8E6" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="27" cy="7" r="2.7" fill="#F6B44A" />
              </svg>
            </span>
            <span>
              <span className="brand-name">
                Token<em>Exchange</em>
              </span>
              <span className="brand-sub" style={{ display: "block" }}>
                AI inference market
              </span>
            </span>
          </a>
          <nav className="nav">
            {navItems.map((n) => (
              <a key={n.key} href={n.to} className={route.name === n.key ? "active" : ""}>
                {n.label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <Ticker items={ticker} onPick={(sym) => navigateToSymbol(sym, navigate)} />

      <main className="container">
        {route.name === "market" && <MarketView navigate={navigate} />}
        {route.name === "models" && <ModelsView navigate={navigate} />}
        {route.name === "providers" && <ProvidersView navigate={navigate} />}
        {route.name === "model" && <ModelView modelId={route.id} navigate={navigate} />}
      </main>

      <footer className="footer">
        <div>
          TokenExchange — estimated figures derived from public OpenRouter data. Prices update hourly. Spend is an
          estimate (tokens × price), not billed revenue.
        </div>
        <div style={{ marginTop: 6 }}>
          Source ·{" "}
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
  | { name: "models" }
  | { name: "providers" }
  | { name: "model"; id: string };

function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#\/?/, "");
  if (clean.startsWith("model/")) {
    return { name: "model", id: decodeURIComponent(clean.slice("model/".length)) };
  }
  if (clean.startsWith("models")) return { name: "models" };
  if (clean.startsWith("providers")) return { name: "providers" };
  return { name: "market" };
}

// The ticker only knows a display symbol; jump to the models list filtered by it.
function navigateToSymbol(sym: string, navigate: (to: string) => void) {
  navigate(`#/models?q=${encodeURIComponent(sym.toLowerCase())}`);
}
