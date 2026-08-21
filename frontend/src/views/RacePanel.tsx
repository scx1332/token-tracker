import { useEffect, useRef, useState } from "react";
import { api, type RacePoint } from "../api";
import { Panel, Loading } from "../components";
import { ModelRaceChart } from "../charts";
import { shortDate } from "../format";

// The race starts Jun 15 2026 — earlier history is noise for today's field.
const RACE_SINCE = "2026-06-15";
// How many days of daily bars fit on the row before they stop being bars.
const BAR_DAYS = 28;
// Models named in the race's bar stacks even when they rank outside the top
// field — fresh launches whose window total lags their run rate (grok-4.6
// shipped 2026-08-12), plus the gpt-5.6 siblings worth telling apart from sol.
const RACE_PINS = ["openai/gpt-5.6-luna", "openai/gpt-5.6-terra", "openai/gpt-5.5", "x-ai/grok-4.6"];

/**
 * The model race, complete with its controls and its own lazy data fetching —
 * shared between the Market page (compact) and the dedicated Race tab (tall,
 * with a real fullscreen mode).
 *
 * `includeFree` is either controlled by the page (the Market view shares one
 * Paid/+Free switch across its charts) or, when the prop is omitted, owned
 * here with its own segmented control.
 */
export function RacePanel({
  includeFree: includeFreeProp,
  height = 380,
  allowFullscreen = false,
}: {
  includeFree?: boolean;
  height?: number;
  allowFullscreen?: boolean;
}) {
  // Price × volume is the market-share signal that matters, so spend leads.
  const [raceMode, setRaceMode] = useState<"spend" | "tokens">("spend");
  // Days lead: the daily grain is where a launch, a price cut or a routing
  // switch actually shows up on the day it happened.
  const [raceBucket, setRaceBucket] = useState<"week" | "day">("day");
  // Stacked lab bars lead — the "who moved the money" read at a glance.
  const [raceStyle, setRaceStyle] = useState<"line" | "bar">("bar");
  const [ownFree, setOwnFree] = useState(false);
  const includeFree = includeFreeProp ?? ownFree;
  // Race points per "bucket:filter" key, fetched lazily at a top-50 field so
  // the bars' "rest of the field" segments sum real models.
  const [raceCache, setRaceCache] = useState<Record<string, RacePoint[]>>({});
  const [raceError, setRaceError] = useState<string | null>(null);

  // Real browser fullscreen on the panel's wrapper; the chart follows the
  // viewport height while it's on.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!allowFullscreen) return;
    const onChange = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [allowFullscreen]);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrapRef.current?.requestFullscreen();
  };

  const raceKey = `${raceBucket}:${includeFree ? "all" : "paid"}`;
  useEffect(() => {
    if (raceCache[raceKey]) return;
    let alive = true;
    setRaceError(null);
    api
      .race({ bucket: raceBucket, top: 50, pin: RACE_PINS, includeFree })
      .then((r) => alive && setRaceCache((c) => ({ ...c, [raceKey]: r.points })))
      .catch((e) => alive && setRaceError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, [raceBucket, raceKey, raceCache, includeFree]);

  const raceFetched = raceCache[raceKey] ?? null;
  const raceWindow = (raceFetched ?? []).filter((p) => p.date >= RACE_SINCE);
  // Daily bars get a short leash: 91 day-slots of stacks is a texture, not a
  // chart. Lines stay long — they cross rather than crowd.
  const raceClipsToRecent = raceStyle === "bar" && raceBucket === "day";
  const racePoints = raceClipsToRecent ? raceWindow.slice(-BAR_DAYS) : raceWindow;
  const raceLoading = raceFetched === null && !raceError;

  // In fullscreen the chart takes the viewport minus the control header.
  const chartHeight = fullscreen ? Math.max(420, window.innerHeight - 150) : height;

  return (
    <div ref={wrapRef} className={fullscreen ? "race-wrap race-wrap-fs" : "race-wrap"}>
      <Panel className="chart-card">
        <div className="chart-head">
          <div>
            <div className="chart-title">The model race</div>
            <div className="chart-note">
              {raceMode === "spend" ? "est. spend" : "tokens"} per {raceBucket} ·{" "}
              {raceBucket === "week" ? "full weeks only" : "one point per day"} ·{" "}
              {raceStyle === "bar" ? "one bar per lab · top models named, the rest of the top 50 as a pale cap" : "top 10"} ·{" "}
              {/* The field is ranked over exactly what's drawn, so the note
                  names the drawn window rather than the fetched one. */}
              {raceClipsToRecent ? `last ${BAR_DAYS} days` : `since ${shortDate(racePoints[0]?.date ?? RACE_SINCE)}`}
            </div>
          </div>
          <div className="seg-row">
            <div className="seg seg-sm">
              <button className={raceMode === "spend" ? "active" : ""} onClick={() => setRaceMode("spend")}>
                Est. spend
              </button>
              <button className={raceMode === "tokens" ? "active" : ""} onClick={() => setRaceMode("tokens")}>
                Tokens
              </button>
            </div>
            <div className="seg seg-sm">
              <button
                className={raceBucket === "day" ? "active" : ""}
                onClick={() => setRaceBucket("day")}
                title="One point per day — a launch or routing switch lands on the day it happened"
              >
                Daily
              </button>
              <button
                className={raceBucket === "week" ? "active" : ""}
                onClick={() => setRaceBucket("week")}
                title="Full ISO weeks — the trend, with weekday noise summed out"
              >
                Weekly
              </button>
            </div>
            <div className="seg seg-sm">
              <button className={raceStyle === "line" ? "active" : ""} onClick={() => setRaceStyle("line")} title="Ten model trends over time">
                Lines
              </button>
              <button
                className={raceStyle === "bar" ? "active" : ""}
                onClick={() => setRaceStyle("bar")}
                title="One stacked bar per lab — Anthropic, OpenAI, Google, X.AI, Z.AI, Others — with each lab's models stacked inside it"
              >
                Bars · by lab
              </button>
            </div>
            {includeFreeProp === undefined ? (
              <div className="seg seg-sm">
                <button className={!ownFree ? "active" : ""} onClick={() => setOwnFree(false)}>
                  Paid
                </button>
                <button className={ownFree ? "active" : ""} onClick={() => setOwnFree(true)}>
                  + Free
                </button>
              </div>
            ) : null}
            {allowFullscreen ? (
              <div className="seg seg-sm">
                <button onClick={toggleFullscreen} title={fullscreen ? "Exit fullscreen (Esc works too)" : "Fill the screen with the race"}>
                  {fullscreen ? "✕ Exit" : "⛶ Fullscreen"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
        {raceLoading ? (
          // Hold the plot's height so switching grain doesn't bounce the row.
          <div style={{ height: chartHeight, display: "grid", placeItems: "center" }}>
            <Loading label="Loading the race…" />
          </div>
        ) : raceError ? (
          <div className="empty" style={{ padding: "40px 10px" }}>Race unavailable — {raceError}</div>
        ) : racePoints.length > 1 ? (
          <ModelRaceChart
            points={racePoints}
            height={chartHeight}
            topN={raceStyle === "bar" ? 12 : 10}
            mode={raceMode}
            bucket={raceBucket}
            style={raceStyle}
            pinned={RACE_PINS}
          />
        ) : (
          <div className="empty" style={{ padding: "40px 10px" }}>
            No {raceBucket === "week" ? "weekly" : "daily"} history yet.
          </div>
        )}
      </Panel>
    </div>
  );
}
