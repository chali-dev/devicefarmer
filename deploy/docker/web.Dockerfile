# syntax=docker/dockerfile:1.7
# Web image (apps/web): the static Vite build served by a tiny Caddy (deploy/docker/web.Caddyfile).
# One per colour; the shared reverse proxy sends /api to the same colour's API. Build context: repo root.
ARG NODE_IMAGE=node:24.22.3-alpine3.23
ARG CADDY_IMAGE=caddy:2.11.6-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci --workspace @cloudphone/web --no-audit --no-fund
COPY apps/web apps/web
RUN npm -w apps/web run build

FROM ${CADDY_IMAGE}
COPY deploy/docker/web.Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="cloudphone-web" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}"
# Unprivileged: listens on a high loopback port, nothing to persist.
ENV XDG_CONFIG_HOME=/tmp XDG_DATA_HOME=/tmp WEB_PORT=8080 WEB_BIND=127.0.0.1 APP_VERSION=${APP_VERSION}
USER 65534:65534
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
