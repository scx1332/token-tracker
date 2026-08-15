# AGENTS.md

## Project Overview

Token Exchange scrapes OpenRouter hourly and presents the AI‑inference market:
model prices (including per‑provider and promotional pricing), daily token
throughput, estimated spend, and a usage‑weighted price index. It also sweeps
**vast.ai** for GPU rental prices, so inference prices can be read against the
cost of the silicon underneath. A Bun + TypeScript backend stores everything in
**PostgreSQL**; a Vite/React/Plotly frontend renders it as a market terminal. A
`docker compose` stack runs Postgres, an ingest worker, the HTTP API, and the
static frontend.

## Commands

```sh
bun install
bun test                                        # unit only (DB tests self-skip)
TEST_DATABASE_URL=postgres://tokens:tokens@localhost:55432/tokens bun test
bun run typecheck

DATABASE_URL=... OPENROUTER_API_KEY=... bun run ingest-once   # one pass
DATABASE_URL=... OPENROUTER_API_KEY=... bun run backfill      # deep history
DATABASE_URL=... bun run serve                                # HTTP API

docker compose up -d --build                    # full stack (or ./deploy.sh)
```

## Important Invariants

- **Price history is a change‑log.** Only insert a `price_points` row when a
  tracked price field actually changes vs. the latest row for that
  `(model_id, provider)`. `pricingChanged()` owns this; provider `""` = the
  model‑level/default price.
- **Usage rows are keyed `(model_id, provider, bucket_date)`.** The hourly
  rankings pass writes with `onConflict: "update"` (authoritative, has the
  prompt/completion split → accurate spend). The backfill writes with
  `onConflict: "refresh-own"` — `DO UPDATE … WHERE source = EXCLUDED.source` —
  so it fills gaps and may restate rows it wrote itself, and still can never
  clobber a rankings row. Plain `"ignore"` left it unable to correct its own
  history: the endpoint double‑count above sat in the table until this mode
  existed. It also prices at effective rates like the hourly pass, or a refresh
  would restate history at list price (~6× too high).
- **Attribution join key is `permaslug` + `variant`.** A catalog model's
  `canonical_slug` **is** its permaslug (verified 1:1). Resolve usage records via
  `resolveUsageModelId` (variant → base fallback; non‑`~` ids beat `~` aliases).
- **`rankings/models?view=day` is the only dense daily source** (all models, one
  latest complete day). `view=week`/`month` add only a sparse tail — do not treat
  them as time series. Deep per‑model history comes from `provider-token-chart`
  (summed across providers) in the backfill.
- **`effective-pricing` is endpoint‑level; usage rows are provider‑level.** One
  slug appears several times in `providerSummaries` (regions/quantizations —
  "Google Vertex" and "Google Vertex (US)" are both `google-vertex`), each with
  its own rates and volume. `collapseProviderEndpoints` (src/usage.ts) blends
  them volume‑weighted into one row per slug before anything is stored or
  fetched. Iterating `eff.providers` directly is how a 444M‑token side endpoint
  at $0.82/Mtok came to price the 389B tokens that ran at $0.20 (+17% on the
  whole revenue tape, since usage rows are keyed by slug and the last write
  won), and how the backfill fetched *and summed* one provider‑token‑chart
  twice (Anthropic model history ran 2–2.5× high). Do not undo the collapse.
- **Schema creation is serialized** by a per‑schema Postgres advisory lock
  (`initSchema`), because `ingest` and `backend` boot together and racing
  `CREATE TABLE IF NOT EXISTS` trips `pg_type_typname_nsp_index`.
- **DATE columns are read as raw `YYYY-MM-DD` strings** (type parser 1082) so a
  non‑UTC server timezone can't shift usage bucket dates.
- **vast.ai `gpu_name` is a literal, space-separated string** (`"H100 SXM"`, not
  `"H100_SXM"`). A wrong spelling in `src/accelerators.ts` returns zero offers
  silently rather than erroring — verify any addition against a live query.
- **The vast.ai bundles search caps every response at 64 offers** regardless of
  `limit`, and ignores `offset` (passing it returns an empty list). `listOffers`
  pages keyset-style on `dph_total >= cursor`, deduplicating by offer id; RTX
  4090 needs four rounds. Do not "simplify" this back to limit/offset.
- **GPU prices are stored per GPU-hour, never per machine.** vast.ai quotes
  `dph_total`/`min_bid` for a whole box, so everything divides by `num_gpus`.
- **The vast.ai offer book is chunk-level; stats are machine-level.** One idle
  8×5090 machine lists as 1×/2×/4×/8× offers of the *same* silicon, so summing
  `num_gpus` over raw offers double-counts depth (~20% for RTX 5090) and the
  duplicated near-identical prices skew every percentile. `collapseMachines`
  (src/gpu.ts) keeps one offer per `machine_id` — the largest chunk, i.e. the
  machine's full rentable inventory — before fencing. Do not sum over raw offers.
- **GPU stats describe the practical rentable market, post-fence.**
  `fenceOffers` (src/gpu.ts) drops deverified hosts and listings priced beyond
  `FENCE_FACTOR`(=3)× either side of the sweep median — zombie asks like a $53
  RTX 5090 against a $0.49 median. Every stat, including depth, bids and the
  verified subset, is computed over the fenced set; `excluded_offers` records
  the drop count. Do not reintroduce raw min/max/mean — they were wrong in
  production within hours (T4 supply-weighted mean $2.36 vs $0.14 median).
- **`gpu_price_snapshots` is a dense time series, not a change-log** (unlike
  `price_points`): the offer book is a continuous auction, so one row per
  `(gpu_name, captured_at)` every pass, all GPUs sharing one capture timestamp.
  A GPU with no offers is stored as a zero-depth row — that is a real
  observation about supply, not missing data. GPU sweeps run on their own
  15-minute clock (`INGEST_GPU_INTERVAL_MS`) inside `ingestLoop`, decoupled
  from the hourly OpenRouter pass; `bun run gpu-once` (also available via
  `docker compose exec ingest bun run gpu-once`) adds a sweep on demand.
- **Daily GPU aggregation happens in SQL** (`getGpuDaily`, `/gpu/daily`), not
  in the browser — at 96 sweeps/day the raw series is too heavy to ship. Day
  semantics: min = best price reachable that day; median/p25/p75 = median of
  the sweeps' values (a deep-book sweep must not outvote a thin one); depth =
  peak. The day column is `TO_CHAR(... 'YYYY-MM-DD')` TEXT on purpose — a
  `::date` would depend on which pool's type parser runs the query.
- **Compute vs token comparisons are indexed, never converted.** $/GPU-hour and
  $/Mtok do not convert without knowing batch efficiency and model size, which
  we do not observe. `frontend/src/gpu.ts` rebases both to 100 and the UI
  compares slopes. `usdPerMtokFloor` exists but is an explicit lower bound.
- **Keep tests hermetic.** `bun test` must pass with no DB and no network;
  storage/server tests skip unless `TEST_DATABASE_URL` (or `DATABASE_URL`) is set.
- **Spend is an estimate** (tokens × observed effective rates where the daily
  sweep has them — these embed cache discounts — with list price as fallback).
  OpenRouter has no total‑revenue endpoint; never present spend as billed
  revenue.

## Implementation Notes

- `src/scraper.ts` — resilient `fetch` (browser headers, backoff, `Retry-After`),
  Cloudflare‑challenge detection + pluggable `setBrowserFallback` (captcha path).
- `src/openrouter.ts` — typed client for `/api/v1/*` and `/api/frontend/v1/*`.
- `src/usage.ts` — parses rankings / effective‑pricing / provider‑token‑chart.
- `src/pricing.ts` — price normalization, change detection, spend math (pure).
- `src/modelMap.ts` — model→row conversion + permaslug/variant → id resolution.
- `src/market.ts` — market aggregates (pure).
- `src/storage.ts` — `pg` pool; idempotent schema; optional `schema` for isolated
  tests. BIGINT/NUMERIC kept as strings; DATE kept raw.
- `src/ingest.ts` — one pass: catalog + model prices → provider prices →
  usage → market snapshot. `src/ingestLoop.ts` loops + runs a one‑time backfill.
- `src/server.ts` — `Bun.serve` JSON API with CORS. Entry: `src/serve.ts`.
  `/model/provider-prices?id=` returns the full per‑provider price change‑log plus
  the provider list; the frontend (`frontend/src/price.ts`, pure + unit‑tested)
  reconstructs the min‑across‑providers envelope and each provider's step series
  from it for the Price Explorer. No historical price backfill exists, so this
  series starts sparse and fills in hourly as prices actually change.
- `src/frontier.ts` — curated frontier families to always surface (mirrored in
  `frontend/src/frontier.ts`).
- `src/vastai.ts` — vast.ai client: public `/api/v0/bundles/` offer search with
  keyset paging, plus `fetchGpuHistory` for the market-metrics endpoints (inert
  without a `machine_read` key — it returns null rather than throwing).
- `src/accelerators.ts` — curated accelerator list (name/label/tier/VRAM).
- `src/gpu.ts` — offer book → price band (pure, unit-tested).
- `src/ingestGpu.ts` — the vast.ai pass. Runs in its own `try` in the loop so a
  vast.ai outage never fails an OpenRouter pass.
- `frontend/src/gpu.ts` — rebasing, the token/compute comparison, and UTC
  hour-of-day profiles (pure, unit-tested). Daily collapsing moved server-side.
- Compute view intraday panels: the 72h tape plots raw sweeps (price + depth on
  a second axis); "The shape of a day" is `hourOfDayProfile` — per-UTC-hour
  medians normalized to 100 = typical hour, hours weighted equally so uneven
  sweep coverage cannot bias the baseline. Token side comes from hourly
  `market_snapshots` via `/market/snapshots`.

## Docker Compose

- Root `Dockerfile` builds one Bun image used by `ingest` and `backend` (role via
  `command:`). `frontend/Dockerfile` builds the static UI + `server.js`.
- All host ports bind to `127.0.0.1` (`BACKEND_PORT` 28470, `FRONTEND_PORT` 28471);
  Postgres is internal only. Required env lives in `.env.example`.
