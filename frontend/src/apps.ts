// Ranking public apps for a single day, in dollars.
//
// OpenRouter publishes two disjoint app views and neither one is what this
// panel wants on its own:
//
//   * `rankings/apps` — day / week / month token counts, no dollars, and no
//     date on any of it (the day bucket is simply the feed's latest full day,
//     the same bucket the model leaderboard dates for us).
//   * our `apps_spend` sweep — real per-app dollars, but only over the trailing
//     ~month, because it is assembled by pricing each model's top-apps list.
//
// Tokens alone rank the wrong thing: an app routing a free or cheap model at
// huge volume outranks one quietly spending more on frontier models. So the
// day view prices each app's day tokens with that app's OWN blended rate from
// the monthly sweep (spend ÷ tokens — it already embeds that app's model mix
// and cache discounts). Apps the sweep never saw fall back to the fleet-wide
// blended rate, which is a real guess and is marked as one.
//
// Pure and dependency-free so the arithmetic can be tested without a fixture
// of the whole market response.

import type { AppSpendRow, AppUsage } from "./api";

export interface RankedApp {
  appId: number | null;
  title: string;
  tokens: number;
  /** Estimated dollars for the day, or null when no rate could be found. */
  spendUsd: number | null;
  /** "own" = this app's monthly blend; "market" = fleet-wide fallback. */
  rateSource: "own" | "market" | null;
}

const key = (title: string) => title.trim().toLowerCase();

/** USD per token, blended across everything the monthly sweep priced. */
export function fleetBlendedRate(spendApps: AppSpendRow[]): number | null {
  let spend = 0;
  let tokens = 0;
  for (const a of spendApps) {
    if (a.tokens > 0 && Number.isFinite(a.spendUsd)) {
      spend += a.spendUsd;
      tokens += a.tokens;
    }
  }
  return tokens > 0 && spend > 0 ? spend / tokens : null;
}

/**
 * Day-bucket apps ranked by estimated spend. Falls back to a token ranking
 * (every `spendUsd` null) when the monthly sweep has not landed yet.
 */
export function rankAppsByDaySpend(dayApps: AppUsage[], spendApps: AppSpendRow[]): RankedApp[] {
  const byId = new Map<number, number>();
  const byTitle = new Map<string, number>();
  for (const a of spendApps) {
    if (!(a.tokens > 0) || !Number.isFinite(a.spendUsd) || a.spendUsd <= 0) continue;
    const rate = a.spendUsd / a.tokens;
    if (a.appId !== null) byId.set(a.appId, rate);
    byTitle.set(key(a.title), rate);
  }
  const fleet = fleetBlendedRate(spendApps);

  const rows: RankedApp[] = dayApps.map((a) => {
    const tokens = a.tokens ?? 0;
    const own = (a.appId !== null ? byId.get(a.appId) : undefined) ?? byTitle.get(key(a.title));
    const rate = own ?? fleet ?? null;
    return {
      appId: a.appId,
      title: a.title,
      tokens,
      spendUsd: rate === null ? null : tokens * rate,
      rateSource: rate === null ? null : own !== undefined ? "own" : "market",
    };
  });

  rows.sort((x, y) => {
    const xs = x.spendUsd;
    const ys = y.spendUsd;
    if (xs !== null && ys !== null && xs !== ys) return ys - xs;
    if (xs === null && ys !== null) return 1;
    if (ys === null && xs !== null) return -1;
    return y.tokens - x.tokens;
  });
  return rows;
}
