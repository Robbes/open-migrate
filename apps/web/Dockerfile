# syntax=docker/dockerfile:1
#
# DRAFT (workplan 0011 T7) — NOT YET VERIFIED on a Docker host. See
# docs/design/0011-t7-dockerfiles-handoff.md.
#
# Builds the Vite React app to static assets and serves them with nginx on :80.
#
# GOTCHA: Vite bakes VITE_* vars at BUILD time. managed.yml currently passes
# VITE_API_URL/VITE_AUTH_URL as runtime env on the web service, which a static
# build ignores. Either pass them as build args here (shown) and set them at
# build time, or switch to runtime config injection. The agent must reconcile
# this with managed.yml.

FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

ARG VITE_API_URL=/api
ARG VITE_AUTH_URL=/auth
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_AUTH_URL=$VITE_AUTH_URL
RUN pnpm --filter @openmig/web build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
# SPA history-fallback so client-side routes resolve to index.html.
RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  location / { try_files $uri $uri/ /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
