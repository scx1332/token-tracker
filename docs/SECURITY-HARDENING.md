# Security hardening of the Docker deployment

This file covers the 2026-11-12 restore on the new host: what changed, why,
how each change was checked, and what was deliberately left alone. Each change
was verified against the running stack. All checks passed: `/health` ok,
`/status` 20/20 ok, a clean ingest pass, the frontend served, and `bun test`
309 pass / 0 fail with integration tests on.

## What changed

| # | Change | Where |
|---|---|---|
| 1 | No fallback DB credentials. Compose fails closed without `POSTGRES_USER/PASSWORD/DB` | `docker-compose.yml`, `.env.example`, `backup-verify.yml` |
| 2 | Every container runs non-root: postgres as `70`, the app as `10001` | compose `user:`, both Dockerfiles `USER` |
| 3 | `read_only: true` root fs, with tmpfs only where something must write | compose |
| 4 | `cap_drop: [ALL]` and `no-new-privileges:true` everywhere | compose (`x-hardening`) |
| 5 | Base images pinned by tag and digest | compose, both Dockerfiles |
| 6 | Memory, CPU and pids limits per service | compose `deploy.resources.limits` |
| 7 | json-file log rotation, 10 MB × 5 per container | compose (`x-hardening`) |
| 8 | Three networks. Postgres sits on an `internal` network the frontend is not on | compose `networks:` |
| 9 | `/backup/latest` refuses weak tokens and serves regular files only | `src/backup.ts`, `src/server.ts` |
| 10 | Multi-stage Bun image with production deps only; `npm ci` for the frontend | `Dockerfile`, `frontend/Dockerfile` |
| 11 | Allowlist `.dockerignore` files; `.gitignore` covers `.env.*` and dumps | `.dockerignore`, `frontend/.dockerignore`, `.gitignore` |
| 12 | Frontend healthcheck | compose |

### 1. Fail-closed credentials
The old compose file fell back to `tokens`/`tokens` whenever a variable was
missing. A deploy without `.env`, or with a typo in it, came up silently with
a well-known superuser password. Now each of the three uses `${VAR:?…}`, so
`docker compose` refuses to interpolate at all:
`required variable POSTGRES_USER is missing a value`. `BACKUP_TOKEN` may
still be empty, because empty already means the route is off.
`OPENROUTER_API_KEY` stays optional because the public endpoints work without it.

The GitHub `backup-verify` workflow ran compose with no `.env` and relied on
those fallbacks. It now sets throwaway `POSTGRES_*` values at workflow level
(user and db stay `tokens`, which its steps hard-code).

### 2. Non-root users, and why uid 10001
The bun and node images ship a uid-1000 user. On this host uid 1000 is
`ubuntu`, which has passwordless sudo. A container escape as uid 1000 would
land as that account, which can write `~/.ssh` and `~/.bashrc`. The app
images therefore run as `10001:10001`, a uid that exists nowhere on the host.
`HOME=/tmp` covers the missing passwd entry. App files stay root-owned, so
the process can read them but not change them.

Postgres runs as the image's own `postgres` user (`70:70`) from the start,
instead of starting as root and dropping privileges with `gosu`. That is why
it needs no capabilities at all. Both cases were checked:

- the existing volume (already owned by 70);
- a brand-new empty volume, where `initdb` ran as 70, i.e. the
  disaster-recovery path.

**Host-side consequence:** the backend mounts the backups directory read-only
as uid 10001, so the directory must be group-readable by gid 10001:

```bash
sudo chgrp 10001 /home/ubuntu/backups/token-tracker
sudo chmod 2750  /home/ubuntu/backups/token-tracker   # setgid: new archives inherit the group
```

### 3–4. Read-only root fs, no capabilities, no privilege escalation
All four containers run with `ReadonlyRootfs=true`, `CapEff=0` and
`NoNewPrivs=1`, checked in `/proc/1/status`. The writable paths are:

- postgres: the data volume, `/var/run/postgresql` (socket and lock) and
  `/tmp`, both tmpfs owned by 70;
- app containers: a small `/tmp` tmpfs (mode 0700).

None of the processes binds a port below 1024 or changes user, so no
capability is needed.

### 5. Pinned images
- `postgres:16.15-alpine@sha256:aa6cb33c…`
- `oven/bun:1.3.13-alpine@sha256:4de47538…`
- `node:22.23.5-alpine@sha256:1314fb30…`

The tag tells a reader what the image is. The digest makes builds
reproducible and stops a re-pushed tag from changing what runs. Bump both
together after checking `docker buildx imagetools inspect <image:tag>`.
Postgres 16.15 matches the version the production dump was taken with.

### 6. Resource limits
| service | cpus | memory | pids | observed at peak |
|---|---|---|---|---|
| postgres | 2 | 2 GiB | 256 | ~230 MiB, 16 pids |
| ingest | 1 | 1 GiB | 128 | ~45 MiB, 19 pids |
| backend | 2 | 1 GiB | 128 | ~32 MiB after a 23 MB `/gpu/series` response |
| frontend | 1 | 256 MiB | 64 | ~15 MiB |

The limits are generous relative to real use. Their job is to stop a runaway
query, a leak or a fork bomb from taking the 32-core host with it.

### 7. Log rotation
`json-file` with `max-size: 10m`, `max-file: 5` caps logs at 50 MB per
container. Before this change, logs grew without bound.

### 8. Network segmentation
| network | internal | members | purpose |
|---|---|---|---|
| `db` | **yes** (no route out) | postgres, ingest, backend | database traffic only |
| `egress` | no | ingest, backend | OpenRouter / vast.ai, backend port |
| `web` | no | backend, frontend | frontend → backend, frontend port |

Verified from inside the containers:

- frontend → postgres:5432 is blocked, and frontend → ingest is blocked;
- frontend → backend:3000 works;
- postgres has no internet access;
- the backend's live OpenRouter proxy (`/model/provider-volume`) still works.

The host listens only on `127.0.0.1:28470` and `127.0.0.1:28471`. Nothing is
published on `0.0.0.0`, and postgres publishes no port.

**Limitation:** the frontend keeps outbound internet access. Docker 29 does
not publish ports from a container that is only on `internal` networks
(tested), and the frontend's port has to be published for nginx. It holds no
secrets and makes no outbound calls.

### 9. `/backup/latest`
The review found these parts already sound:

- Auth is a bearer token compared in constant time. Both sides are SHA-256
  hashed first, then `timingSafeEqual`, so the length doesn't leak either.
- No request input reaches the path. The file name comes from a directory
  listing filtered by `^tokens-\d{4}-\d{2}-\d{2}\.sql\.7z$`.
- An unauthenticated request is rejected before any file I/O.
- The archive holds public market data only. The production dump was checked:
  it contains none of the deployment's secrets.

Two gaps, now closed:

- **Weak token.** A short `BACKUP_TOKEN`, or the `.env.example` placeholder
  (which is 36 chars), used to enable the route. `usableBackupToken()` now
  keeps the route at 404 unless the token is at least 32 chars and is not the
  placeholder. The server logs a startup warning when it refuses one. The
  production token is 64 chars.
- **Symlink.** Anyone able to write to the backups dir could plant
  `tokens-2099-01-01.sql.7z -> /proc/self/environ`. The newest-by-name file
  would then serve the backend's environment (DB password, token) to a token
  holder. The handler now `lstat`s the entry and serves regular files only.
  This was tested live: the planted symlink got 503 and the real archive got
  200 with a matching `X-Backup-Sha256`.

### 10–11. Image and context hygiene
- The Bun image is now multi-stage: a `deps` stage runs
  `bun install --production --ignore-scripts`. The runtime holds only `src/`
  and the `pg` dependency tree, with no TypeScript and no `@types`.
- The frontend uses `npm ci`, so it installs exactly what the lockfile says.
- Both `.dockerignore` files are allowlists (`*`, then `!` the few inputs).
  `.env`, any `.env.*` copy, dumps, archives, `.git` and `scratch/` can't
  reach the build context, the BuildKit cache or a layer, whatever a future
  `COPY` says. The root context dropped to about 24 kB.
- `docker history` and the image configs were checked: none of the `.env`
  secret values appear.
- `.gitignore` now also covers `.env.*` (except `.env.example`), `*.sql.7z`,
  `/tokens-*.sql`, `*.dump` and `backups/`.

## Considered and not done

- **File-based secrets (`/run/secrets`).** Secrets are still passed as
  environment variables, so `docker inspect` shows them to anyone who can use
  the Docker socket. Compose 2.40 refuses `environment:`- and
  `content:`-sourced secrets or configs on `read_only` services ("`file` is
  the sole supported option"; tested). `file:` secrets would mean a second
  on-disk copy of every secret beside `.env`, which drifts on rotation, plus
  `*_FILE` support in the app. Mitigations in place:
  - each service gets only its own secrets: the frontend gets none, the
    backend gets the DB URL and backup token, ingest gets the DB URL and the
    OpenRouter/vast.ai keys, postgres gets its password;
  - `.env` is mode 600;
  - the Docker socket is `root:docker 0660` and nobody is in the `docker` group.

  If this matters later, move to a secrets manager or sops-encrypted files and
  add `*_FILE` support.
- **Daemon-level settings** (`/etc/docker/daemon.json`) are host
  configuration outside this repo, so they are recommended below, not applied.

## Recommendations (not applied)

1. **Firewall.** UFW is inactive. Only sshd (key-only, no root login, no
   passwords) listens publicly today. Enable a default-deny inbound policy
   that allows 22 (and 80/443 once nginx is installed here). Docker-published
   ports bypass UFW's INPUT rules, so the `127.0.0.1:` binding in compose is
   what keeps 28470/28471 private. Keep it.
2. **`daemon.json`:**
   - `"log-driver": "json-file"` with `"log-opts": {"max-size": "10m", "max-file": "5"}`
     as a default for every container;
   - `"no-new-privileges": true`;
   - `"live-restore": true`;
   - consider `"userns-remap": "default"`, so container root never maps to host root.
3. **Docker group.** Keep `ubuntu` out of the `docker` group. Membership is
   root-equivalent. Run compose through `sudo`.
4. **Backups.** No cron is installed on this host yet; the README expects
   03:30 daily. Suggested root crontab line:
   `30 3 * * * /home/ubuntu/scx1332/token-tracker/scripts/backup-db.sh >/dev/null 2>&1`.
   Consider `umask 027` in the script, and an encrypted off-host copy.
5. **Continuous deploy.** `gitploy.py` (`git pull` + `./deploy.sh` every 60 s,
   giving anyone who can push to `main` code execution on the host) has been
   removed. Deploy a reviewed, ideally signed, tag by hand with `./deploy.sh`.
6. **CI supply chain (done).** `actions/checkout` (v7.0.1) and
   `oven-sh/setup-bun` (v2.2.0) are pinned to commit SHAs, and
   `production-check.yml` pins `bun-version: 1.3.13` to match `BUN_IMAGE`.
   - Confirm the GHCR `token-tracker-backup` package is private (it is, per
     the owner).
7. **Frontend dependencies.** `npm audit fix` cleared the critical
   maplibre-gl/plotly.js issues and the high probe-image-size and
   source-map-js ones. `bun audit` on the backend is clean. Two findings
   remain, both affecting only the vite dev server, never the production
   bundle: vite <=6.4.3 (high) and its esbuild <=0.24.2 (moderate). Fixing
   them needs vite 5 -> 8, a major upgrade to plan separately.
8. **Smaller items.**
   - The API echoes internal error messages (`Internal error: …`).
   - `/market/race?top=` has no upper bound.
   - `server.js` sets no security headers (CSP, `X-Content-Type-Options`); add
     them in nginx.
   - Authenticated fetches use `redirect: "follow"`; consider
     `redirect: "error"` so a redirect can never carry the OpenRouter key elsewhere.
9. **`VASTAI_API_KEY` is unused.** `fetchGpuHistory()` has no callers, so the
   key only adds exposure until something uses it. Remove it from `.env` if no
   use is planned.
