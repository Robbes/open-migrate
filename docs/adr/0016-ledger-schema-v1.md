# ADR-0016: Ledger schema v1

- **Status:** Accepted
- **Date:** 2026-06-20

## Context
The ledger is the correctness core (idempotency, mapping, drift decisions, runs, verification, cutover). It must work identically in the managed (PostgreSQL) and self-host (SQLite/small Postgres) editions, support multi-tenant isolation, and never store secrets.

## Decision
Adopt the schema in `packages/ledger/migrations/0001_init.sql`:
- **`item`** as the idempotency ledger, anchored by `UNIQUE (tenant_id, mapping_id, natural_key_hash)` with a `content_hash`.
- **Stable identity** via `mailbox.external_id` (immutable Graph GUID).
- **`sync_checkpoint`** for per-collection delta tokens; **`collection_mapping`** for special-use folders.
- Shared addresses via **`mailbox_mapping.pattern`** + **`group_def`** (Pattern S/D).
- **`decision`/`policy_preset`** for the drift decision queue; **`verification`/`cutover`** for the gate; **`backup_target`** for optional extra backup; **`run`/`run_event`/`audit_log`** for status and audit.
- Portability: `text` + `CHECK` instead of Postgres enums; secrets only as `secret_ref`; `ON DELETE CASCADE` from `tenant` for GDPR erasure; RLS in managed, query-level tenant filtering in self-host.
- Access layer: **Drizzle ORM** (dual pg/sqlite), SQL as source of truth.

## Consequences
- One schema, two backends; identical migration behavior.
- Deletions recorded, never auto-applied (non-destructive).
- `item` may need partitioning for very large mailboxes (future).

## Alternatives considered
- Postgres enums: harder migrations, no SQLite equivalent — rejected for text+CHECK.
- Separate schemas per edition: rejected — divergence risk.
