# syntax=docker/dockerfile:1
#
# DRAFT (workplan 0011 T7) — NOT YET VERIFIED on a Docker host. See
# docs/design/0011-t7-dockerfiles-handoff.md before relying on this.
#
# Runs the managed API. The workspace packages (@openmig/*) ship TypeScript
# source (their package.json "main"/"exports" point at src/*.ts, there is no JS
# build), so the app runs under tsx rather than tsc→node. Copying the whole /app
# between stages preserves pnpm's node_modules symlink layout.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
# Non-root runtime user.
RUN useradd --system --uid 10001 --home-dir /app appuser && chown -R appuser:appuser /app
USER appuser
EXPOSE 3001
# DATABASE_URL / APP_DATABASE_URL / JWT_SECRET / SECRET_ENCRYPTION_KEY come from compose env.
CMD ["pnpm", "--filter", "@openmig/api", "exec", "tsx", "src/index.ts"]
