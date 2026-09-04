import { useEffect, useState } from "react";
import { api, type MarketResponse } from "../api";
import { Panel, SectionHead, RankList, Loading, ErrorNote } from "../components";
import { shortDate } from "../format";
import { isClosedDay } from "../runningDay";
import { GROUPINGS, groupingByKey, type GroupingKey } from "../grouping";
import { GroupedStackPanel, groupedRankItems } from "./GroupedBoard";

/** How many bands the stack names before pooling the rest. */
const STACK_TOP: Record<GroupingKey, number> = { family: 8, lab: 8, origin: 4, class: 4 };

/**
 * Best models: the revenue leaderboard and its stacked history, summed the
 * way the question is being asked — by product line, by lab, by where the
 * lab is, or by the capability tier the model sells in. The grouping lives in
 * the URL (`/best?by=lab`) so a view can be linked.
 */
export function BestView({ by, navigate }: { by?: string; navigate: (to: string) => void }) {
  const grouping = groupingByKey(by);
  const [market, setMarket] = useState<MarketResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Free-tier traffic is volume without a market: default it out.
  const [includeFree, setIncludeFree] = useState(false);

  useEffect(() => {
    let alive = true;
    setMarket(null);
    // The board needs the latest-day tape and the weekly race; the daily
    // series that dominates /market's payload is not used here, so ask for
    // the shortest window.
    api
      .market(7, includeFree)
      .then((m) => alive && setMarket(m))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [includeFree]);

  if (error) return <ErrorNote error={error} />;
  if (!market) return <Loading />;

  const date = market.topModels[0]?.bucketDate ?? null;
  const dayNote = date ? (isClosedDay(date, Date.now()) ? "last complete day" : "day still running") : null;
  const bySpend = groupedRankItems(market.topModels, grouping, "spend");
  const byTokens = groupedRankItems(market.topModels, grouping, "tokens");

  return (
    <>
      <SectionHead
        eyebrow="Order flow"
        title="Best models"
        right={
          <div className="seg-row">
            <div className="seg seg-sm">
              {GROUPINGS.map((g) => (
                <button
                  key={g.key}
                  className={g.key === grouping.key ? "active" : ""}
                  onClick={() => navigate(g.key === "family" ? "/best" : `/best?by=${g.key}`)}
                  title={`Rows are ${g.rows}; hover a row for its ${g.parts}`}
                >
                  {g.label}
                </button>
              ))}
            </div>
            <div className="seg seg-sm">
              <button className={!includeFree ? "active" : ""} onClick={() => setIncludeFree(false)}>
                Paid
              </button>
              <button className={includeFree ? "active" : ""} onClick={() => setIncludeFree(true)}>
                + Free
              </button>
            </div>
          </div>
        }
      />
      <div className="chart-note" style={{ marginTop: -6, marginBottom: 12 }}>
        Rows are {grouping.rows}. Hover a row or a band for its {grouping.parts}, each with its share.
      </div>

      <div className="two-col">
        <Panel className="panel-pad">
          <div className="chart-head">
            <div className="chart-title">By est. spend · {date ? shortDate(date) : "—"}</div>
            <div className="chart-note">tokens × effective rate{dayNote ? ` · ${dayNote}` : ""}</div>
          </div>
          <RankList items={bySpend} onNavigate={navigate} />
        </Panel>
        <Panel className="panel-pad">
          <div className="chart-head">
            <div className="chart-title">By tokens · {date ? shortDate(date) : "—"}</div>
            <div className="chart-note">volume routed, whatever it was priced at{dayNote ? ` · ${dayNote}` : ""}</div>
          </div>
          <RankList items={byTokens} onNavigate={navigate} />
        </Panel>
      </div>

      <div style={{ marginTop: 16 }}>
        <GroupedStackPanel
          key={grouping.key}
          weeklyPoints={market.race.points}
          includeFree={includeFree}
          grouping={grouping}
          title={`${grouping.label} over time`}
          rowsNote={grouping.rows}
          topN={STACK_TOP[grouping.key]}
          height={420}
        />
      </div>
      <div className="chart-note" style={{ marginTop: 10 }}>
        Est. spend is tokens × observed effective rates — an estimate, not billed revenue. The stack's field is the top
        50 models of the window plus a few pinned launches; the leaderboards read the latest day's top 80. Class
        placements are curated for the head of the tape and read off the slug for the tail — a rough tier, not a
        benchmark.
      </div>
    </>
  );
}
