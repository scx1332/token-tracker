import { encodeModelId } from "../routes";
import { useEffect, useState } from "react";
import { api, type ModelDetail } from "../api";
import { Badge, Panel, Loading, ErrorNote, Empty } from "../components";
import { PriceHistoryChart, UsageHistoryChart, C } from "../charts";
import { perMtok, compact, usd, shortDate, displayName } from "../format";
import { isFrontier } from "../frontier";

export function ModelView({ modelId, navigate }: { modelId: string; navigate: (to: string) => void }) {
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError(null);
    api
      .model(modelId, 180)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [modelId]);

  if (error) return <ErrorNote error={error} />;
  if (!detail) return <Loading label={`Loading ${modelId}…`} />;

  const m = detail.model;
  const providerPrices = [...detail.providerPrices].sort((a, b) => (a.promptUsd ?? 1e9) - (b.promptUsd ?? 1e9));
  const latestUsage = detail.usage.at(-1);

  return (
    <>
      <a className="back-link" href="/models" onClick={(e) => { e.preventDefault(); navigate("/models"); }}>
        ← All models
      </a>

      <div className="detail-head">
        <div>
          <h1>
            {displayName(m.name)}{" "}
            {isFrontier(m.modelId) && <Badge kind="frontier">frontier</Badge>}{" "}
            {m.isFree && <Badge kind="free">free</Badge>}
          </h1>
          <div className="detail-id mono">{m.modelId}</div>
        </div>
        <div className="pricebar">
          <div className="pb">
            <div className="pb-label">Input / M</div>
            <div className="pb-val val-min">{m.isFree ? "$0" : perMtok(m.promptUsd)}</div>
          </div>
          <div className="pb">
            <div className="pb-label">Output / M</div>
            <div className="pb-val val-gold">{m.isFree ? "$0" : perMtok(m.completionUsd)}</div>
          </div>
          <div className="pb">
            <div className="pb-label">Est. spend/day</div>
            <div className="pb-val val-gold">{usd(latestUsage?.estimatedSpendUsd ?? m.latestSpendUsd)}</div>
          </div>
          <div className="pb">
            <div className="pb-label">Daily tokens</div>
            <div className="pb-val mono">{compact(latestUsage?.tokens ?? m.latestTokens)}</div>
          </div>
          <a
            className="btn-primary"
            href={`/explorer/${encodeModelId(m.modelId)}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/explorer/${encodeModelId(m.modelId)}`);
            }}
          >
            Price Explorer →
          </a>
        </div>
      </div>

      {m.promotionText && (
        <div className="signal promo-signal" style={{ marginTop: 14 }}>
          <span className="sig-dot" style={{ background: C.violet }} />
          {m.promotionText}
        </div>
      )}

      {m.description && <p className="detail-desc">{m.description.slice(0, 360)}{m.description.length > 360 ? "…" : ""}</p>}

      {/* Charts */}
      <div className="grid chart-grid" style={{ marginTop: 20 }}>
        <Panel className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">Estimated spend &amp; usage</div>
              <div className="chart-note">daily est. spend · last 180 days</div>
            </div>
            <div className="legend">
              <span><i style={{ background: C.gold }} /> spend</span>
              <span><i style={{ background: C.cyan }} /> tokens</span>
            </div>
          </div>
          {detail.usage.length > 1 ? <UsageHistoryChart rows={detail.usage} height={260} /> : <Empty label="No usage history yet." />}
        </Panel>
        <Panel className="chart-card">
          <div className="chart-head">
            <div>
              <div className="chart-title">Price history</div>
              <div className="chart-note">model-level input / output $/Mtok</div>
            </div>
            <div className="legend">
              <span><i style={{ background: C.cyan }} /> input</span>
              <span><i style={{ background: C.gold }} /> output</span>
            </div>
          </div>
          {detail.priceHistory.length >= 1 ? (
            <PriceHistoryChart rows={ensureTwoPoints(detail.priceHistory)} height={260} />
          ) : (
            <Empty label="No price points recorded yet." />
          )}
        </Panel>
      </div>

      {/* Providers */}
      <div className="section-head">
        <div>
          <div className="eyebrow">Order book</div>
          <h2 className="section-title">{providerPrices.length} providers serving this model</h2>
        </div>
        <span className="count-note mono">click a provider to chart it in the explorer</span>
      </div>
      {providerPrices.length ? (
        <div className="table-wrap">
          <table className="tt">
            <thead>
              <tr>
                <th className="left">Provider</th>
                <th>Input $/M</th>
                <th>Output $/M</th>
                <th>Context</th>
                <th>Quant</th>
              </tr>
            </thead>
            <tbody>
              {providerPrices.map((p, i) => (
                <tr
                  key={p.provider + i}
                  onClick={() => navigate(`/explorer/${encodeModelId(m.modelId)}?provider=${encodeURIComponent(p.provider)}`)}
                >
                  <td className="left" style={{ fontFamily: "var(--font-body)", fontWeight: 500 }}>
                    {p.provider}
                    {i === 0 && <Badge kind="free">cheapest</Badge>}
                  </td>
                  <td className="val-min">{p.isFree ? "$0" : perMtok(p.promptUsd)}</td>
                  <td className="val-gold">{p.isFree ? "$0" : perMtok(p.completionUsd)}</td>
                  <td style={{ color: "var(--muted)" }}>{p.contextLength ? compact(p.contextLength, 0) : "—"}</td>
                  <td style={{ color: "var(--muted)" }}>{p.quantization ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty label="No per-provider pricing captured yet." />
      )}

      {/* Meta */}
      <div className="section-head">
        <div>
          <div className="eyebrow">Spec sheet</div>
          <h2 className="section-title">Details</h2>
        </div>
      </div>
      <div className="meta-grid">
        <Meta k="Author" v={m.author} />
        <Meta k="Context length" v={m.contextLength ? m.contextLength.toLocaleString() : "—"} />
        <Meta k="Modality" v={m.modality ?? "—"} />
        <Meta k="Tokenizer" v={m.tokenizer ?? "—"} />
        <Meta k="Knowledge cutoff" v={m.knowledgeCutoff ?? "—"} />
        <Meta k="First seen" v={shortDate(m.firstSeenAt)} />
        <Meta k="Moderated" v={m.isModerated === null ? "—" : m.isModerated ? "yes" : "no"} />
        <Meta k="Variant" v={m.variant ?? "standard"} />
      </div>
    </>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="m">
      <div className="m-k">{k}</div>
      <div className="m-v">{v}</div>
    </div>
  );
}

// A single price point renders as a dot; duplicate it at the window edges so the
// step line spans the chart instead of collapsing to one marker.
function ensureTwoPoints<T extends { observedAt: string }>(rows: T[]): T[] {
  if (rows.length !== 1) return rows;
  const only = rows[0]!;
  const now = new Date().toISOString();
  return [only, { ...only, observedAt: now }];
}
