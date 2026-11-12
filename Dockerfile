# One Bun image for both `ingest` and `backend` (role chosen by compose `command:`).
#
# Base pinned by tag *and* digest: the tag says what it is, the digest makes the
# build reproducible and immune to a re-pushed tag. Bump both together:
#   docker buildx imagetools inspect oven/bun:<version>-alpine
ARG BUN_IMAGE=oven/bun:1.3.13-alpine@sha256:4de475389889577f346c636f956b42a5c31501b654664e9ae5726f94d7bb5349

# --- deps: production dependencies only (no typescript/@types in the runtime) ---
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# --- runtime ---
FROM ${BUN_IMAGE}
WORKDIR /app

ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV BUILD_DATE=${BUILD_DATE}
# The uid below has no passwd entry, so give it a HOME it can write (a tmpfs
# under the read-only root fs in compose).
ENV HOME=/tmp

# Non-root, and deliberately not the image's `bun` user (uid 1000): uid 1000 is
# `ubuntu` on the host, which has sudo, so a container escape as 1000 would land
# as a privileged host account. 10001 exists nowhere on the host. App files stay
# root-owned and read-only to this user.
USER 10001:10001

# The docker-compose services override this per role (serve / ingest).
CMD ["bun", "run", "serve"]
