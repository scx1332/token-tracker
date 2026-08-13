# AGENTS.md

## Project Overview

Token Exchange scrapes OpenRouter hourly and presents the AI‑inference market:
model prices (including per‑provider and promotional pricing), daily token
throughput, estimated spend, and a usage‑weighted price index. A Bun + TypeScript
backend stores everything in **PostgreSQL**; a Vite/React/Plotly frontend renders
it as a market terminal. A `docker compose` stack runs Postgres, an ingest worker,
the HTTP API, and the static frontend.

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
  `onConflict: "ignore"` (gap‑filler only — never clobber a rankings row).
- **Attribution join key is `permaslug` + `variant`.** A catalog model's
  `canonical_slug` **is** its permaslug (verified 1:1). Resolve usage records via
  `resolveUsageModelId` (variant → base fallback; non‑`~` ids beat `~` aliases).
- **`rankings/models?view=day` is the only dense daily source** (all models, one
  latest complete day). `view=week`/`month` add only a sparse tail — do not treat
  them as time series. Deep per‑model history comes from `provider-token-chart`
  (summed across providers) in the backfill.
- **Schema creation is serialized** by a per‑schema Postgres advisory lock
  (`initSchema`), because `ingest` and `backend` boot together and racing
  `CREATE TABLE IF NOT EXISTS` trips `pg_type_typname_nsp_index`.
- **DATE columns are read as raw `YYYY-MM-DD` strings** (type parser 1082) so a
  non‑UTC server timezone can't shift usage bucket dates.
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

## Docker Compose

- Root `Dockerfile` builds one Bun image used by `ingest` and `backend` (role via
  `command:`). `frontend/Dockerfile` builds the static UI + `server.js`.
- All host ports bind to `127.0.0.1` (`BACKEND_PORT` 28470, `FRONTEND_PORT` 28471);
  Postgres is internal only. Required env lives in `.env.example`.
