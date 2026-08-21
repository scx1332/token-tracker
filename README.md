# Token Exchange — an AI inference market terminal

Live: **https://token-tracker.arkiv-global.net**

Token Exchange scrapes OpenRouter every hour and turns it into a market view of the
AI‑inference economy: what the world pays to run frontier text models, how much
gets spent, and where prices are moving. The goal is an early read on repricing
and demand shifts across the model market.

It tracks **every** OpenRouter model (~410 live), **every provider** per model,
their prices (including promotional discounts), and daily token throughput — and
derives estimated daily spend (tokens × price) plus a usage‑weighted price index.

It also sweeps the **vast.ai** GPU rental marketplace hourly, so the price of
inference can be read against the price of the silicon underneath it: when token
prices fall faster than accelerator rental, something other than hardware cost is
driving them down.

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
| GPU rental prices | `GET https://console.vast.ai/api/v0/bundles/` | live offer book per accelerator; **public, no key** |

### GPU rental prices (the Compute view)

16 accelerators are tracked — B200, B300, H200/H200 NVL, the H100 family, A100,
L40S, RTX PRO 6000, RTX 5090/4090/3090, T4 — and every one's **full** offer book
is swept **every 15 minutes** (`INGEST_GPU_INTERVAL_MS`), on a clock decoupled
from the hourly OpenRouter pass. vast.ai quotes whole machines, so all prices
are normalized to **USD per GPU‑hour** (an 8×B200 box at $85/hr is
$10.63/GPU‑hr).

Prices describe the **practical rentable market**, not the raw listing feed:
listings from deverified hosts, and listings priced more than 3× either side of
the sweep median — parked asks nobody rents (a $53/GPU‑hr RTX 5090 against a
$0.49 median, a $12 T4 against $0.15) — are fenced out before any statistic is
computed, and the excluded count is stored per sweep.

Each sweep stores a percentile **band** rather than one number, because the
rental market is thin and bimodal: min (the floor you can actually rent at), p25,
median, p75, the cheapest interruptible bid, the "verified host" subset's floor
and median — plus offer count and GPUs available as a measure of depth. The
sub‑hourly cadence is what powers the intraday views: a 72‑hour tape of every
sweep, and an hour‑of‑day profile showing how GPU floors, supply depth and token
prices each behave across a UTC day.

Two quirks of the vast.ai API worth knowing: responses are hard‑capped at **64
offers** regardless of `limit` and `offset` is ignored, so the client pages
keyset‑style on price; and the documented historical endpoints
(`/api/v0/metrics/gpu/history/`) need a key with the **`machine_read`** permission
group, which host accounts have and client accounts do not. The live offer book
needs no key at all, so GPU history accumulates from first ingest forward.

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
  vast.ai     ── hourly ─►             │                    + GPU rental prices
   public bundles API     └──────┬──────┘
                                │ writes
                         ┌──────▼──────┐
                         │  Postgres   │  models · price_points · usage_snapshots
                         │             │  market_snapshots · gpu_price_snapshots
                         │             │  ingest_runs · kv_state
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
- **Frontend** (`frontend/`): Vite + React 18 + Plotly, styled as a light,
  technical analytics workstation (the native system sans-serif; teal = tokens, amber =
  dollars, indigo = price). The **Price Explorer** lets you pick any model and
  follow its price across every provider over time — the bold line is the
  cheapest provider (the *minimum*), inside the min–max spread band, with a live
  per-provider "order book" you can click to pin one company. Served in production
  by `server.js` (static files + `/api` proxy).
- **Deploy**: `docker compose` (postgres + ingest + backend + frontend, all bound
  to `127.0.0.1`), fronted by the host nginx with a Let's Encrypt cert.

## API

All endpoints are JSON, CORS‑enabled, served under `/api` by nginx.

| Route | Description |
| --- | --- |
| `GET /health` | build info, ingest status, data coverage, DB stats |
| `GET /status` | the production checks, evaluated live — `503` when any of them fails |
| `GET /market?days=120` | latest snapshot, spend/token series, price‑index history, top models, top apps, weekly chart |
| `GET /models?search=&author=&limit=` | all models with latest price + latest usage |
| `GET /models/featured?limit=16` | frontier‑pinned + top‑by‑usage |
| `GET /model?id=<id>&days=180` | model + model‑level price history + per‑provider prices + usage |
| `GET /model/provider-prices?id=<id>&days=365` | full per‑provider price change‑log + provider list — drives the Price Explorer's min‑envelope and order book |
| `GET /prices?model=<id>&provider=<p>` | price history |
| `GET /usage?model=<id>` | usage history |
| `GET /providers` | per‑provider rollup (model count, cheapest/avg $/Mtok) |
| `GET /apps`, `GET /usage/weekly` | cached ranking blobs |
| `GET /gpu` | curated accelerator list, each with its latest vast.ai price band |
| `GET /gpu/series?gpu=B200&days=30` | per-sweep GPU price bands (omit `gpu` for all; sub-hourly) |
| `GET /gpu/daily?gpu=B200&days=60` | UTC-day aggregates, rolled up in SQL |
| `GET /market/snapshots?days=14` | hourly market snapshots — the token side's intraday series |
| `GET /market/race?bucket=week\|day&days=91` | per‑model spend/tokens over time — the model race. `/market` already carries the weekly points; the daily grain is ~7× the rows, so it is fetched here on demand |

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

### Backups

`scripts/backup-db.sh` takes a **plain SQL** dump of the whole database and
7z‑compresses it. Cron runs it daily at 03:30 local; it is safe to run by hand
at any time.

```bash
./scripts/backup-db.sh                       # now
BACKUP_DIR=/mnt/other ./scripts/backup-db.sh # somewhere else
7z t /home/ubuntu/backups/token-tracker/tokens-2026-08-15.sql.7z   # still sound?
```

Archives land in `/home/ubuntu/backups/token-tracker/` as
`tokens-YYYY-MM-DD.sql.7z`, ~1.4 MB each (27 MB of SQL, 19×). The narrative goes
to `backup.log` in the same directory. Retention keeps 30 dailies plus every
first‑of‑month indefinitely.

Text, not `-Fc`: a SQL dump can be read, grepped and partly salvaged, and
restoring it never needs a matching `pg_restore`. `pg_dump` runs *inside* the
container so its version always matches the server. Compression is PPMd rather
than LZMA2 — on a real dump it was both smaller (1.44 MB vs 1.54 MB) and six
times faster, which is what PPMd is for on text.

Every run verifies before it keeps anything: the dump must carry pg_dump's
completion marker (a truncated dump otherwise looks fine until you need it), and
the finished archive is decompressed and SHA‑compared against the dump it came
from. A failed run leaves no archive and prunes nothing.

Restore, from this directory:

```bash
7z x -so /home/ubuntu/backups/token-tracker/tokens-2026-08-15.sql.7z \
  | docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
```

The dump carries `DROP ... IF EXISTS` for everything it recreates, so it
restores over a live database as well as into an empty one — destructive by
design, so aim it deliberately.

Nightly, `.github/workflows/backup-verify.yml` pulls the newest archive off the
host, restores it into an empty Postgres, boots the real backend against it and
smoke‑tests the API (`scripts/verify-restore.sql`), then keeps the copy as a
private GHCR package. A backup nobody has restored is a hope, not a backup.

### Is it still scraping?

A scraper that stops does not crash. The container stays up, the pass still
reports `ok`, every page still renders — and one chart quietly stops moving.
That is the failure this project is actually exposed to, so it gets its own
tests.

```bash
bun run prod-check                                # test the live deployment
PROD_BASE_URL=https://staging.example bun run prod-check
PROD_API_URL=http://127.0.0.1:28470 bun test src/production.test.ts
```

`GET /api/status` is the deployment judging itself. `src/monitor.ts` holds the
judgements — pure, so `src/monitor.test.ts` can run them against fixtures of
every failure mode, because an untested alarm is worse than no alarm — and
`Storage.getMonitorFacts()` feeds it the facts:

- **Each source separately**, by the age of its newest row: the hourly pass, the
  catalog, the rankings feed, per‑provider usage, effective prices, provider
  volume, market snapshots, the 15‑minute vast.ai sweep, the price change‑log.
  Thresholds come from each source's real cadence, so a dead vast.ai reads as a
  dead vast.ai and not as a dead market.
- **The last closed day, sized against the week before it**, in tokens and in
  dollars. Freshness only proves rows arrived; this proves they arrived *whole*.
  A capture that dies mid‑day writes a perfectly fresh row holding half a day.
  Both sides are fenced: the endpoint double‑count that inflated history 2–2.5×
  would have failed here too.
- **The history itself** — no missing days between the first and the last, and
  the floor still at 2026‑05‑18. A day missed today can never be re‑fetched
  (§5 of `knowledge.md`), so a hole is permanent and worth shouting about.
- **The backup**, by the age and size of the newest archive.
- **From outside**, which `/status` cannot see at all: nginx routing, the
  frontend and its assets, the TLS certificate's remaining days, and the actual
  JSON each page consumes.

`fail` means data is being lost right now or a number on the site is wrong;
`warn` means unusual but nothing is lost by waiting; `skip` means the fact
needed to judge it is not available here (no backup mount on a dev box).
Anything OpenRouter or vast.ai may legitimately do on a quiet day is a `warn` at
most — an alarm that cries wolf gets muted. `/status` answers `503` when
anything fails, so a plain uptime pinger is a usable alarm too, while `/health`
stays `200` throughout: Docker restarts the container on an unhealthy check and
restarting the API fixes none of these.

`.github/workflows/production-check.yml` runs all of it hourly and emails on
failure. Each check becomes one test, so the mail names `gpu.sweep` rather than
"production", and the job summary is the whole table either way.

## Scraping notes

OpenRouter's public and frontend JSON endpoints are not currently Cloudflare‑
challenged, so the scraper (`src/scraper.ts`) uses plain `fetch` with browser‑like
headers, retries/backoff, and `Retry‑After` handling. It **detects** Cloudflare
challenges and exposes a pluggable browser fallback (`setBrowserFallback`) so a
Playwright/captcha path can be added later without touching call sites.
