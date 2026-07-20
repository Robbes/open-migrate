# syntax=docker/dockerfile:1
#
# Self-host appliance image (workplan 0010 T3).
#
# Single-tenant bundle for a NAS / mini-PC / Pi. On startup the entrypoint
# (apps/selfhost/src/index.ts) applies the ledger migrations under an advisory
# lock (T1), loads the mapping configs from /data/config, schedules them with
# the in-process croner scheduler, and serves /healthz + /status. It talks to
# the bundled Postgres from deploy/selfhost/compose.yml.
#
# The @openmig/* packages ship TypeScript source (package.json "main"/"exports"
# point at src/*.ts — there is no JS build), so the app runs under tsx rather
# than tsc→node. Copying the whole /app between stages preserves pnpm's
# node_modules symlink layout and keeps packages/ledger/migrations available at
# runtime (runMigrations resolves them relative to its own module URL).
#
# HARD RULE 5: this image must never pull in managed-only code (Trigger.dev,
# billing, RLS-app-user). The entrypoint imports @openmig/scheduler/in-process
# (a Trigger-free subpath), not the package index. The no-managed-leakage guard
# test (apps/selfhost/src/no-managed-leakage.unit.test.ts) enforces this.
#
# NOTE (§22.1): base images should be digest-pinned at release. The pin is left
# as a tag here because a real digest cannot be resolved in the authoring
# environment (no registry access); the release pipeline pins node:24-slim to a
# sha256 digest and publishes under the stable/edge channels (see
# docs/selfhost-quickstart.md, workplan T6).

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- build: install the whole workspace (source-ships-TS, run under tsx) ----
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---- runtime: non-root, health-checked ----
FROM base AS runtime
ENV NODE_ENV=production
# Where the appliance reads mapping JSONs and stores state (mounted volume).
ENV CONFIG_DIR=/data/config
ENV PORT=8080
# Bind on all interfaces inside the container; publish is controlled by compose.
ENV HOST=0.0.0.0
COPY --from=build /app /app
# Non-root runtime user; owns /app and the /data mount point.
RUN useradd --system --uid 10001 --home-dir /app appuser \
  && mkdir -p /data/config \
  && chown -R appuser:appuser /app /data
USER appuser
EXPOSE 8080
# DATABASE_URL and any tokenFromEnv/passwordFromEnv secrets come from the
# compose env-file. The status server answers /healthz once migrations applied.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@openmig/selfhost", "exec", "tsx", "src/index.ts"]
