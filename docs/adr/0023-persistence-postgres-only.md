# ADR-0023: Persistence — Postgres-only across both editions

- **Status:** Accepted
- **Date:** 2026-07-16
- **Supersedes (in part):** ADR-0010 (the SQLite / dual-backend option), ADR-0016 (its "dual pg/sqlite access layer" clause). The rest of both ADRs — Postgres+RLS for managed, the ledger schema v1, non-destructive/idempotency semantics — still stands.

## Context
ADR-0010/0016 specified **two** ledger backends: SQLite (or small Postgres) for self-host, managed Postgres+RLS for the service, behind one Drizzle "dual pg/sqlite" schema. In practice the SQLite path was never gated (no parity tests), and the multi-tenant/RLS/cutover work (migrations `0002`–`0010`) evolved the schema into **Postgres-specific SQL** — `DO $$…$$` blocks, `CREATE ROLE`, RLS `POLICY`/`FORCE ROW LEVEL SECURITY`, `bigint`, advisory locks — none of which SQLite understands. Commit `6d9ecd4` then deleted `schema-sqlite.ts`/`sqlite-ledger.ts` as "unapproved scope." That left the tree Postgres-only in fact while the ADRs still promised SQLite — an unowned drift.

Maintaining a genuinely dual-dialect ledger (two migration sets or a dialect-aware layer, RLS emulated as query-level filtering on SQLite, parity tests on every change) is a standing tax on every schema change, for a self-host audience that in 2026 comfortably runs a small Postgres container on a Pi 5 / NAS / mini-PC (container-first is already the packaging baseline, ADR-0019).

## Decision
**Use PostgreSQL as the single ledger backend for both editions.** The self-host edition **bundles a small Postgres container** in its compose stack (single-tenant, local volume); the managed edition uses managed Postgres with RLS. One dialect, one migration set, one access layer. SQLite is dropped.

- The schema/migration source of truth remains `packages/ledger/migrations/*.sql` (Postgres), Drizzle ORM over `pg`/`postgres`, Atlas lint (ADR-0017 unchanged).
- Self-host tenant isolation is **trivial** (single tenant); it does not depend on RLS. RLS remains a managed-edition mechanism.
- "Self-host must keep working" (AGENTS.md hard rule 5) is preserved: no *managed-only* dependency (Trigger.dev, vault, IdP) leaks into self-host — Postgres is a shared, edition-neutral dependency, not a managed control-plane one.

## Consequences
- **Simpler core:** one dialect; migrations like `0009_create_app_user_role.sql` no longer need a SQLite equivalent; no parity-test matrix.
- **Heavier lightest-host footprint:** a single-user Pi now runs a Postgres container (~tens of MB RAM idle) instead of an embedded file. Acceptable given container-first packaging; documented in the self-host quickstart.
- **Docs to update:** AGENTS.md ledger line; solution-architecture §7.3 (State row), §22.1 (migrations), §22.1 testing gates; workplan 0010 rewritten around bundled Postgres.
- **Reversible:** if a truly embedded self-host is ever demanded, a future ADR can reintroduce an embedded Postgres (e.g. `pglite`/`embedded-postgres`) without touching SQL, since the dialect stays Postgres.

## Alternatives considered
- **Restore dual pg/sqlite (honor ADR-0010/0016):** true Pi-light self-host, but reinstates the dual-dialect tax and requires re-porting 10 Postgres-only migrations + emulating RLS on SQLite. Rejected by owner (2026-07-16) as not worth the ongoing cost.
- **Embedded Postgres (pglite / embedded-postgres) for self-host:** keeps one dialect *and* removes the container. Attractive but less proven for a durable long-running ledger; parked as the reversibility path above, not chosen now.
