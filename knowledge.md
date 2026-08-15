# knowledge.md — what this data is, and what it is not

Operational knowledge about Token Exchange's numbers: where each figure comes
from, when we started collecting it, which parts are estimates, and which
artifacts have already bitten us. `AGENTS.md` holds the code invariants; this
file holds the ones about the *data*.

Last verified against the live database on **2026-08-15**.

Keep it current whenever a data fact changes; it is committed and pushed with
everything else in the repo, not by a separate ritual.

---

## 1. Coverage at a glance

**Usage history starts Monday 2026-05-18.** That is the first day we keep, and
it is a Monday on purpose: coverage originally opened Friday 2026-05-15, which
left a three-day Fri/Sat/Sun stub in front of the first full Mon–Sun week. The
stub was also the only stretch the endpoint-double-count repair could not
restate from source (it had aged past the ~90-day chart window), so on
2026-08-15 those 522 rows were deleted. The series now opens on a complete
week, and every day we store is a day the charts display.

The trim is permanent: OpenRouter's `provider-token-chart` window had already
moved past those dates, so no re-run can bring them back.

### When each scraper started running

The project was deployed on **2026-08-12**. Everything below is first live
capture, in UTC — deep usage history predates it only because it was
backfilled.

| Source | Scraping since | What it covers |
|---|---|---|
| OpenRouter catalog + prices (`price_points`) | **2026-08-12 17:57** | change-log; a price is only stored when it moves |
| Hourly market aggregate (`market_snapshots`) | **2026-08-12 17:57** | one row per pass, ~hourly |
| Daily usage, model-level (`usage_snapshots`, `provider=''`) | **2026-08-12 17:57** | daily buckets back to 2026-05-18 (backfilled) |
| Per-provider request volume (`provider_volume_snapshots`) | **2026-08-12 22:51** | `stats/endpoint`, trailing ~30-min counts |
| Effective prices (`effective_price_snapshots`) | **2026-08-12 23:03** | usage-weighted real paid rates, per model and provider |
| Daily usage, per-provider (`usage_snapshots`, `provider<>''`) | **2026-08-12 23:10** | daily buckets back to 2026-05-18, 43 models |
| vast.ai GPU rentals (`gpu_price_snapshots`) | **2026-08-13 21:57** | 16 accelerators, 15-minute sweeps |

So: **usage history reaches back to 2026-05-18, but nothing else does.** Prices,
provider volume, effective rates and GPU rentals only exist from the dates
above, because no public endpoint serves their history. Charts that mix them
(the price index, compute-vs-tokens) are short by nature and fill in daily.

---

## 2. The one date that changes what a chart means: 2026-08-11

Model-level daily usage comes from two different sources, split at 2026-08-11:

| | 2026-05-18 → 2026-08-10 | 2026-08-11 → today |
|---|---|---|
| Source | `provider-token-chart`, summed across a model's providers (backfill) | `rankings/models?view=day` (hourly pass) |
| Models per day | ~130–200 — only what the backfill sweeps (top 80 by usage + frontier) | ~500 — the whole catalog |
| Prompt/completion split | none; spend blends at the model's observed mix | real, per day |

Consequences, both of which are visible on the Providers page:

- Before 2026-08-11 the "whole market" line is really "the ~200 models we
  backfilled", which is close to the set the revenue tape prices — so the two
  curves hug each other. After it, the line is the full catalog and the ~20%
  gap to the tape is a genuine long tail.
- The blended basis prices the same tokens differently than the real split. At
  a 98–99% prompt share against a 16× output premium, a 2pp error in the assumed
  mix moves estimated revenue ~25%. Do not read small tape-vs-market differences
  as signal.

`rankings/models?view=day` is the only dense daily source and returns just the
latest complete day, which is why deep history had to come from elsewhere at
all. `view=week` / `view=month` are not time series.

### When a day becomes final

Within an hour of UTC midnight, and then it stops moving. The feed serves
exactly one date — the day that has ended — and flips at the boundary: measured
across 2026-08-14/15, the hourly pass read 11.135T (the 13th's final figure) at
23:57, 11.485T (the 14th's) at 00:57, and 11.486T at every pass for the twenty
hours after that. +0.01%. **The first pass after midnight already has the whole
day**, and it keeps rewriting the same date all day with `onConflict: "update"`,
so it is a value the site can be trusted on immediately.

Which means **the model-level series normally ends on yesterday**, and a row for
the day in progress only exists when someone has run `bun run backfill`
mid-day: that sums provider-token-chart across providers for every date in the
window, including the unfinished one, and plants a partial figure (2026-08-15
went in at 6.22T across 203 models against the ~11T/500-model day it became).
It corrects itself at the next midnight — rankings writes `update` and wins,
while chart writes are `refresh-own` and can never take an authoritative day
back to partial — so it is cosmetic, but it is worth knowing that the low last
point on a chart after a repair run is the repair, not the market.

The per-provider tape (`provider<>''`) is the opposite case: the daily sweep
writes the in-progress day *every* day, so its last bar is always short, and
what completes it is the next sweep re-fetching the same ~90-day window with
`onConflict: "update"` within ~21 hours. Nothing else restates those rows —
rankings only ever writes `provider=''`.

---

## 3. Spend is an estimate, and here is its exact recipe

OpenRouter publishes no revenue. Every dollar on this site is
`tokens × rate`, where `rate` is, in order of preference:

1. the model's **usage-weighted effective rate** from `stats/effective-pricing`
   (this embeds cache discounts — Kimi K3 came out at $0.73/M against $3 list),
2. list price from the catalog, for models outside the top-40 daily sweep.

Where a row carries a real prompt/completion split, spend is
`prompt × in + completion × out`. Where it does not, it blends at the model's
own observed prompt share (`getObservedPromptShare`), *not* a flat 90/10 — the
market runs 97–99% input tokens, and a flat 90/10 overweights output ~2×.

Cache reads are ~10% of input price almost everywhere, and OpenRouter reports
`total_native_tokens_cached` as zero for every model, so cached volume is
unobservable. Effective rates capture the discount in aggregate; per-model
figures remain ceilings.

**Never present these numbers as billed revenue.** "Estimated" is not a
disclaimer here, it is the accurate word.

---

## 4. Artifacts that have already bitten us

**The effective-pricing payload is endpoint-level, not provider-level.** One
slug appears several times ("Google Vertex" and "Google Vertex (US)" are both
`google-vertex`), each with its own rates and volume. Everything downstream is
keyed by provider, so iterating it directly did damage in three places until
`collapseProviderEndpoints` (src/usage.ts) landed on 2026-08-15:

- provider usage rows are keyed `(model, provider, date)` and written last-wins,
  so a 444M-token side region at $0.82/Mtok priced the 389B tokens that actually
  ran at $0.20 — gemini-3.6-flash read $334K/day instead of $93K. 34 pairs
  across 17 models, ~17% of the whole revenue tape;
- `effective_price_snapshots` collected 2–3 ambiguous rows per provider;
- the backfill fetched the same chart once per endpoint and summed them all, so
  Anthropic models' deep history carried **2.0–2.5× their real tokens**.

That last one is why the market curve used to show ~$7M/day in June sliding to
~$4M in August. **The decline was not real.** Repaired, the backfilled history
went from $457.9M to $252.3M (−45%) and the curve is flat-to-rising, tracking
token growth. Models whose providers appear once were never affected — their
ratio was exactly 1.00 throughout, which is how the bug was identified.

OpenRouter's own numbers were consistent the whole time. Where both its
endpoints cover the same day, `provider-token-chart` and `rankings` agree per
model to 1.00. Reach for "our assembly is wrong" before "the source is faking".

---

## 5. Repairing history

`docker compose exec ingest bun run backfill` is the repair command. It is safe
and idempotent: writes use `onConflict: "refresh-own"`
(`DO UPDATE … WHERE source = EXCLUDED.source`), so it restates rows this source
wrote and can never touch an authoritative rankings row. It targets every model
it has ever written, not just today's busiest, and prices at effective rates.

Its reach is the source's window, roughly the last 90 days, and that window
slides one day per day. **Anything older than ~90 days can never be restated
again** — if a systematic error is found, the choice is repair now or live with
it. The May 2026 stub is the precedent: patched in SQL, then trimmed.

One-off repair scripts live in `scratch/` (gitignored) with their reasoning in
comments; they are records, not tools — none of them can apply twice.

Which is also why two of the production checks (`src/monitor.ts`, served at
`/status`) are about history rather than uptime: `usage.gaps` fails if any day
between the first and the last has no rows, and `usage.floor` fails if the
series stops starting on 2026-05-18. Both describe damage that no amount of
re-running can undo, so they are worth hearing about the same day rather than
the next time someone looks at a chart. If the floor is ever moved deliberately,
move the constant with it.

Which makes the daily backup part of the data story, not just ops: once a day
has aged out of the source's window, **our database is the only copy of it
anywhere**. `scripts/backup-db.sh` (cron, 03:30 local, → `~/backups/token-tracker/`,
30 dailies + every first-of-month) is what stands between a bad `DELETE` and
history that cannot be re-fetched at any price. Restore instructions are in the
README; the archives are plain SQL inside 7z, so a single table can be pulled
out of one with `grep` if that is all that is wanted.

---

## 6. Open items

- **Provider rows blend at the model's pooled prompt share**, not the day's
  actual split, so the revenue tape reads ~10% over the market line on some
  days. Pricing each day at that day's observed share would close it and leave
  coverage as the only difference between the two curves.
- **The 2026-08-11 source boundary is not marked in the UI.** The revenue tape's
  footnote explains the two bases, but nothing on the chart shows where deep
  history ends and full-catalog coverage begins.
- **Tail apps and models are undercounted by design** — per-app spend is
  assembled from each swept model's top-5 apps, so an app that is never top-5
  anywhere is invisible.
