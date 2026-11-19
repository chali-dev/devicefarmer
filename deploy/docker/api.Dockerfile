# syntax=docker/dockerfile:1.7
# API image (apps/api). Build context: repo root.
#   docker buildx build -f deploy/docker/api.Dockerfile --build-arg APP_VERSION=<v> --build-arg GIT_SHA=<sha> -t <image>:<v> .
# DEX_HELPERS=0 skips the two app_process helpers (secure capture, scrcpy relay): the API then falls back
# (secure source unavailable, relay off) and the build needs no Android SDK download.
ARG NODE_IMAGE=node:24.22.3-alpine3.23
ARG JDK_IMAGE=eclipse-temurin:17.0.20.1_1-jdk-noble

# ---- device tools: official scrcpy-server (SHA-256 pinned in fetch.sh) ----
FROM ${NODE_IMAGE} AS scrcpy
RUN apk add --no-cache bash curl
COPY infra/device-tools/scrcpy/fetch.sh /tools/scrcpy/fetch.sh
RUN OUT=/out bash /tools/scrcpy/fetch.sh && chmod 0644 /out/*

# ---- device tools: official SDK zips (sha1 pinned in fetch-sdk.sh), cached separately from the sources ----
FROM ${NODE_IMAGE} AS sdk
ARG DEX_HELPERS=1
RUN apk add --no-cache bash curl
COPY infra/device-tools/fetch-sdk.sh /tools/fetch-sdk.sh
RUN mkdir -p /sdk && if [ "$DEX_HELPERS" = 1 ]; then SDK_DL=/sdk bash /tools/fetch-sdk.sh; fi

FROM ${JDK_IMAGE} AS dex
ARG DEX_HELPERS=1
COPY --from=sdk /sdk /sdk
COPY infra/device-tools/compile-dex.sh /tools/compile-dex.sh
COPY infra/device-tools/capture/CpCapture.java /src/capture/
COPY infra/device-tools/relay/CpRelay.java /src/relay/
RUN mkdir -p /out/capture /out/relay && if [ "$DEX_HELPERS" = 1 ]; then \
      bash /tools/compile-dex.sh /src/capture CpCapture.java cpcapture.dex /sdk /out/capture && \
      bash /tools/compile-dex.sh /src/relay CpRelay.java cprelay.dex /sdk /out/relay; \
    fi

# ---- TypeScript build ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci --workspace @cloudphone/api --no-audit --no-fund
COPY apps/api apps/api
RUN npm -w apps/api run build

# ---- production dependencies only ----
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci --workspace @cloudphone/api --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM ${NODE_IMAGE}
# ssh: BitBrowser adb tunnels; pg_dump + pg_restore 17 (= Postgres major in deploy/compose.shared.yml): backups + 导入;
# ffmpeg/ffprobe: media processing; procps: pkill of stale tunnels; tini: PID 1 reaps ssh children.
RUN apk add --no-cache openssh-client-default postgresql17-client ffmpeg procps-ng tini \
  && pg_dump --version && pg_restore --version && ffprobe -version | head -1 && ssh -V
WORKDIR /app/apps/api
COPY --from=prod-deps --chown=root:root /app/node_modules /app/node_modules
COPY --chown=root:root package.json /app/package.json
COPY --chown=root:root apps/api/package.json ./package.json
COPY --chown=root:root apps/api/drizzle ./drizzle
COPY --from=build --chown=root:root /app/apps/api/dist ./dist
# Same relative layout as a checkout, so the config defaults (../../infra/device-tools/...) apply unchanged.
COPY --from=scrcpy /out/ /app/infra/device-tools/scrcpy/out/
COPY --from=dex /out/capture/ /app/infra/device-tools/capture/out/
COPY --from=dex /out/relay/ /app/infra/device-tools/relay/out/
# var/ (uploads, library, local assets, logs, BitBrowser known_hosts) is a volume shared by both colours.
RUN mkdir -p var && chown node:node var
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="cloudphone-api" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}"
ENV NODE_ENV=production APP_VERSION=${APP_VERSION} PG_DUMP_CMD=pg_dump
USER node
ENTRYPOINT ["/sbin/tini", "--"]
# Migrations are a separate one-off command (deploy.sh): node dist/db/migrate.js
CMD ["node", "dist/main.js"]
