# Token Exchange — an AI inference market terminal

Live: **https://token-tracker.arkiv-global.net**

Token Exchange scrapes OpenRouter every hour and turns it into a market view of the
AI‑inference economy: what the world pays to run frontier text models, how much
gets spent, and where prices are moving. The goal is an early read on repricing
and demand shifts across the model market.

It tracks **every** OpenRouter model (~410 live), **every provider** per model,
their prices (including promotional discounts), and daily token throughput — and
derives estimated daily spend (tokens × price) plus a usage‑weighted price index.

![dashboard](docs/dashboard.png)

## What it collects

| Signal | Source | Notes |
| --- | --- | --- |
| Model catalog + list pricing | `GET /api/v1/models` | ~410 models, `prompt`/`completion` $ per token |
| Per‑provider pricing + promos | `GET /api/v1/models/{author}/{slug}/endpoints` | `pricing.discount` = promo; quantization, context, uptime |
| Daily token volume (per model) | `GET /api/frontend/v1/rankings/models?view=day` | prompt + completion split → accurate spend |
| Deep history (~90d daily) | `GET /api/frontend/v1/stats/provider-token-chart` | summed across a model's providers (backfill) |
| 1‑year weekly race | `GET /api/frontend/v1/rankings/model-rankings-chart` | top‑10 weekly totals |
| Top apps | `GET /api/frontend/v1/rankings/apps` | who routes the tokens |

Prices are stored as a **change‑log**: a new row is written only when a price
actually changes, so history is exact and compact. Usage is a daily time series;
estimated spend is computed from the model's current price.

> Spend is an **estimate** (tokens × price), not OpenRouter's billed revenue —
> OpenRouter exposes no total‑revenue endpoint. See `docs/` and `AGENTS.md`.

## Architecture

```
                         ┌─────────────┐
  OpenRouter  ── hourly ─►   ingest     │  bun run ingest   (catalog, prices,
   public + frontend APIs │  (worker)   │                    usage, backfill)
                         └──────┬──────┘
                                │ writes
                         ┌──────▼──────┐
                         │  Postgres   │  models · price_points · usage_snapshots
                         │             │  market_snapshots · ingest_runs · kv_state
                         └──────┬──────┘
                                │ reads
                         ┌──────▼──────┐        ┌──────────────┐
                         │  backend    │◄───────┤   frontend   │  Vite + React +
   nginx  /api/*  ──────►│  Bun.serve  │  /api  │  (Plotly UI) │  Plotly, served
   nginx  /      ────────────────────────────► │  server.js   │  by a tiny node
                         └─────────────┘        └──────────────┘  static+proxy
```

- **Backend** (`src/`): Bun + TypeScript + `pg`. `ingest` (hourly worker),
  `serve` (HTTP API), `backfill` (one‑shot deep history). Idempotent schema with a
  per‑schema advisory lock so `ingest` and `backend` can create it concurrently.
- **Frontend** (`frontend/`): Vite + React 18 + Plotly. A market terminal —
  dollars are gold, tokens are cyan, numbers are monospace. Served in production by
  `server.js` (static files + `/api` proxy).
- **Deploy**: `docker compose` (postgres + ingest + backend + frontend, all bound
  to `127.0.0.1`), fronted by the host nginx with a Let's Encrypt cert.

## API

All endpoints are JSON, CORS‑enabled, served under `/api` by nginx.

| Route | Description |
| --- | --- |
| `GET /health` | build info, ingest status, data coverage, DB stats |
| `GET /market?days=120` | latest snapshot, spend/token series, price‑index history, top models, top apps, weekly chart |
| `GET /models?search=&author=&limit=` | all models with latest price + latest usage |
| `GET /models/featured?limit=16` | frontier‑pinned + top‑by‑usage |
| `GET /model?id=<id>&days=180` | model + model‑level price history + per‑provider prices + usage |
| `GET /prices?model=<id>&provider=<p>` | price history |
| `GET /usage?model=<id>` | usage history |
| `GET /providers` | per‑provider rollup (model count, cheapest/avg $/Mtok) |
| `GET /apps`, `GET /usage/weekly` | cached ranking blobs |

## Local development

```sh
bun install

# one Postgres for everything
docker run -d --name tt-pg -e POSTGRES_USER=tokens -e POSTGRES_PASSWORD=tokens \
  -e POSTGRES_DB=tokens -p 127.0.0.1:55432:5432 postgres:16-alpine
export DATABASE_URL=postgres://tokens:tokens@127.0.0.1:55432/tokens
export OPENROUTER_API_KEY=sk-or-...

bun run ingest-once            # one ingestion pass (catalog + prices + usage)
bun run backfill               # deep daily history for top/frontier models
bun run serve                  # API on :3000

# frontend (proxies /api to :39100 by default — set BACKEND_ORIGIN to match)
cd frontend && npm install && npm run dev
```

Tests are hermetic; DB‑backed tests self‑skip unless `TEST_DATABASE_URL` is set:

```sh
bun test                                                     # unit tests only
TEST_DATABASE_URL=$DATABASE_URL bun test                     # + integration
bun run typecheck
```

## Deployment

`docker compose up -d --build` (or `./deploy.sh`, which stamps `BUILD_COMMIT` /
`BUILD_DATE`). Secrets live in `.env` (see `.env.example`). The host nginx site
proxies `token-tracker.arkiv-global.net` → `127.0.0.1:28471` (frontend) and
`/api` → `127.0.0.1:28470` (backend); `gitploy.py` re‑runs `deploy.sh` on new
commits.

## Scraping notes

OpenRouter's public and frontend JSON endpoints are not currently Cloudflare‑
challenged, so the scraper (`src/scraper.ts`) uses plain `fetch` with browser‑like
headers, retries/backoff, and `Retry‑After` handling. It **detects** Cloudflare
challenges and exposes a pluggable browser fallback (`setBrowserFallback`) so a
Playwright/captcha path can be added later without touching call sites.
