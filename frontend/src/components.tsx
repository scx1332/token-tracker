import type { ReactNode } from "react";
import { Sparkline } from "./charts";
import { compact, pct } from "./format";

export function Panel({ children, className = "", pad = false }: { children: ReactNode; className?: string; pad?: boolean }) {
  return <div className={`panel ${pad ? "panel-pad" : ""} ${className}`}>{children}</div>;
}

export function Delta({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null || !Number.isFinite(value)) return <span className="delta flat">—</span>;
  const rising = value > 0.0005;
  const falling = value < -0.0005;
  const cls = rising ? (invert ? "down" : "up") : falling ? (invert ? "up" : "down") : "flat";
  const arrow = rising ? "▲" : falling ? "▼" : "•";
  return (
    <span className={`delta ${cls}`}>
      {arrow} {pct(Math.abs(value))}
    </span>
  );
}

export function Kpi({
  label,
  dot,
  value,
  unit,
  sub,
  spark,
  sparkColor,
}: {
  label: string;
  dot?: "gold" | "cyan" | "violet" | "up";
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  spark?: (number | null)[];
  sparkColor?: string;
}) {
  return (
    <div className="panel kpi">
      <div className="kpi-label">
        {dot && <span className={`kpi-dot dot-${dot}`} />}
        {label}
      </div>
      <div className="kpi-value mono">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {sub && <div className="kpi-sub">{sub}</div>}
      {spark && spark.length > 1 && (
        <div className="kpi-spark">
          <Sparkline values={spark} color={sparkColor} height={34} />
        </div>
      )}
    </div>
  );
}

export function Badge({ kind, children }: { kind: "free" | "frontier" | "promo" | "ghost"; children: ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export function Loading({ label = "Loading market data…" }: { label?: string }) {
  return (
    <div className="loading">
      <div className="spinner" />
      {label}
    </div>
  );
}

export function ErrorNote({ error }: { error: string }) {
  return <div className="empty">Could not load data — {error}</div>;
}

export function Empty({ label }: { label: string }) {
  return <div className="empty">{label}</div>;
}

export function SectionHead({ eyebrow, title, right }: { eyebrow: string; title: string; right?: ReactNode }) {
  return (
    <div className="section-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2 className="section-title">{title}</h2>
      </div>
      {right}
    </div>
  );
}

export interface RankItem {
  name: string;
  sub?: string;
  value: number | null;
  valueLabel: string;
  frac: number; // 0..1 bar width
  href?: string;
  color?: string;
}

export function RankList({ items, onNavigate }: { items: RankItem[]; onNavigate?: (href: string) => void }) {
  return (
    <div className="rank-list">
      {items.map((it, i) => (
        <div
          key={i}
          className="rank-row"
          style={it.href ? { cursor: "pointer" } : undefined}
          onClick={it.href && onNavigate ? () => onNavigate(it.href!) : undefined}
        >
          <div className="rank-n mono">{i + 1}</div>
          <div className="rank-body">
            <div className="rank-name">{it.name}</div>
            <div
              className="rank-bar"
              style={{
                width: `${Math.max(3, Math.min(100, it.frac * 100))}%`,
                background: it.color ? `linear-gradient(90deg, ${it.color}, ${it.color}55)` : undefined,
              }}
            />
          </div>
          <div className="rank-val mono">{it.valueLabel}</div>
        </div>
      ))}
    </div>
  );
}

export interface TickerItem {
  sym: string;
  price: string;
  volume: number | null;
  free: boolean;
}

export function Ticker({ items, onPick }: { items: TickerItem[]; onPick?: (sym: string) => void }) {
  if (items.length === 0) return null;
  const doubled = [...items, ...items];
  return (
    <div className="ticker" aria-label="Frontier model price tape">
      <div className="ticker-track">
        {doubled.map((it, i) => (
          <span
            key={i}
            className="tick"
            style={onPick ? { cursor: "pointer" } : undefined}
            onClick={onPick ? () => onPick(it.sym) : undefined}
          >
            <span className="tick-sym">{it.sym}</span>
            <span className="tick-px val-gold">{it.price}</span>
            <span className={`tick-delta ${it.free ? "up" : ""}`} style={{ color: it.free ? undefined : "var(--cyan)" }}>
              {it.free ? "FREE" : `${compact(it.volume)}·tok`}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
