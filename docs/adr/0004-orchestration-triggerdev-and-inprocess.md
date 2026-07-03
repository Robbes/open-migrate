# ADR-0004: Orchestration via Trigger.dev (managed) + in-process scheduler (self-host)

- **Status:** Accepted
- **Date:** 2026-06-20

## Context
We need robust scheduling, retries, concurrency budgets, and long-running tasks. The ledger already holds durable migration state, so full durable-execution is helpful but not essential. Self-host must remain possible, including local dev on an arm64 Spark.

## Decision
Define a **`Scheduler`/`JobRunner` interface** with two implementations:
- **Self-host:** in-process scheduler (croner/node-cron), no heavy orchestrator.
- **Managed:** **Trigger.dev** (Apache-2.0, TS-native, durable long-running tasks, retries, idempotency, tenant-scoped concurrency), **self-hostable via Docker** or Trigger.dev Cloud.
Workers run on our/the user's infra; because imapsync/rclone move data directly source->target, the orchestrator never sees message content (only metadata).

## Consequences
- Matches the Apache-2.0 + TypeScript + low-ops goals.
- Self-host stays light; managed can be self-hosted or cloud.
- Orchestrator is swappable behind the interface.

## Alternatives considered
- Temporal (MIT): strongest durable execution but heavier self-host (own DB + services) and a monthly Cloud floor (~$100-200). Kept as a heavyweight fallback.
- Hatchet (Postgres-only): viable lighter option; reuses Postgres.
- Windmill: AGPL core + commercial clause on re-exposing to users — conflicts with maximal-use.
- n8n: fair-code, not OSI-open — rejected as core.
