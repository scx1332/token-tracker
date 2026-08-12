FROM oven/bun:1.3.13-alpine

WORKDIR /app

ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV BUILD_DATE=${BUILD_DATE}

# The docker-compose services override this per role (serve / ingest).
CMD ["bun", "run", "serve"]
