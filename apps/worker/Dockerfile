# syntax=docker/dockerfile:1
#
# DRAFT (workplan 0011 T7) — NOT YET VERIFIED on a Docker host. See
# docs/design/0011-t7-dockerfiles-handoff.md.
#
# Runs the managed worker. NOTE: the Trigger.dev v4 task model deploys tasks to
# the Trigger.dev instance rather than running a long-lived process; whether this
# image should run `trigger deploy`, a dev worker, or the plain entrypoint is an
# open question for the agent to settle against a real trigger.dev self-host.
# For now it runs the worker entrypoint under tsx (same source-ships-TS reason as
# the API).

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
# DATABASE_URL / APP_DATABASE_URL / SECRET_ENCRYPTION_KEY / TRIGGER_* from compose env.
CMD ["pnpm", "--filter", "@openmig/worker", "exec", "tsx", "src/index.ts"]
