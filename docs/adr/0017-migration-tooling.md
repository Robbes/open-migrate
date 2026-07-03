# ADR-0017: Migration tooling — Drizzle Kit (+ Atlas lint), not Liquibase

- **Status:** Accepted
- **Date:** 2026-06-20

## Context
We need schema **and** data migrations for both PostgreSQL (managed) and SQLite (self-host) in a TypeScript/Node stack; the self-host edition runs on small hardware (Pi/NAS). Liquibase and Flyway are mature and DB-agnostic but JVM-based.

## Decision
- **Author and apply** migrations with **Drizzle Kit** (TS-native, supports PostgreSQL and SQLite, matches the chosen Drizzle ORM). SQL lives in `packages/ledger/migrations`.
- **Lint** migrations in CI with **Atlas** (single Go binary, multi-arch) for destructive-change detection and multi-dialect verification.
- **Data migrations** are versioned with the schema change, **idempotent**, **batched** for the large `item` table, using **expand-contract** for backward compatibility.
- Migrations **run on startup behind a lock** (Postgres advisory lock / SQLite file lock); the app **refuses to start if the schema is newer than it supports**.
- **Do not use Liquibase/Flyway** — JVM weight conflicts with a Node stack and Pi/NAS self-host.

## Consequences
- No JVM dependency; one toolchain for both backends; small footprint for self-host.
- Rollback is **roll-forward-preferred** (down-migrations only where cheap) — accepted; mitigated by DB backups and feature flags.
- Atlas adds a CI safety net against accidental destructive changes.

## Alternatives considered
- Liquibase / Flyway (rich rollback, contexts): rejected — JVM weight.
- dbmate (Go, multi-DB SQL): viable, but Drizzle Kit already aligns with the ORM.
- Raw SQL only: rejected — no linting/safety net.
