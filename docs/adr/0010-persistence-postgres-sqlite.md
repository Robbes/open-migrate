# ADR-0010: Persistence — Postgres+RLS (managed) / SQLite or small Postgres (self-host)

- **Status:** Accepted; **partially superseded by [ADR-0023](0023-persistence-postgres-only.md)** (2026-07-16) — the SQLite / dual-backend option is dropped; both editions now use Postgres (self-host bundles a small Postgres). The Postgres+RLS-for-managed decision below still stands.
- **Date:** 2026-06-20

## Context
The ledger and control-plane need durable storage in both editions, with multi-tenant isolation in the managed service.

## Decision
**Managed:** managed **Postgres with Row-Level Security** (per-tenant isolation). **Self-host:** **SQLite** (single-user, lightest) or a small **Postgres** container. Same ledger schema contract; migrations versioned (tool TBD: e.g., drizzle/atlas/prisma).

## Consequences
- One schema, two backends; behavior identical.
- RLS provides tenant isolation in managed.
- SQLite keeps self-host viable on a Pi.

## Alternatives considered
- Postgres everywhere: heavier for single-user self-host.
