# Base pinned by tag *and* digest (see the root Dockerfile). Bump both together:
#   docker buildx imagetools inspect node:<version>-alpine
ARG NODE_IMAGE=node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

FROM ${NODE_IMAGE} AS build
WORKDIR /app

# `npm ci`: install exactly what package-lock.json pins, or fail.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# --- runtime: static bundle + a dependency-free node server, nothing else ---
FROM ${NODE_IMAGE}
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY server.js ./

ENV NODE_ENV=production
ENV PORT=23561
EXPOSE 23561

# Non-root, and not the image's `node` user (uid 1000 = `ubuntu` on the host).
USER 10001:10001

CMD ["node", "server.js"]
