# syntax=docker/dockerfile:1
#
# DRAFT (workplan 0011 T7) — NOT YET VERIFIED on a Docker host. See
# docs/design/0011-t7-dockerfiles-handoff.md.
#
# Runs the managed scheduler (apps/worker/src/managed-scheduler.ts), a
# long-running, multi-tenant process that polls mailbox_mapping for active
# rows and runs their scheduled syncs — see that file's header for why this
# exists instead of `src/index.ts` (single-mapping, file-config CLI — the
# self-host shape) or the Trigger.dev jobs under src/jobs/* (real long-term
# path, but unreachable until a trigger.config.ts + `trigger deploy` step
# exist). Runs under tsx (same source-ships-TS reason as the API).

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
RUN useradd --system --uid 10001 --home-dir /app appuser && chown -R appuser:appuser /app
USER appuser
EXPOSE 8082
# DATABASE_URL / APP_DATABASE_URL / SECRET_ENCRYPTION_KEY / TRIGGER_* from compose env.
CMD ["pnpm", "--filter", "@openmig/worker", "exec", "tsx", "src/managed-scheduler.ts"]
