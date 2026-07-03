# ADR-0015: Backup scope — stack DR vs end-user data vs optional extra backup

- **Status:** Accepted
- **Date:** 2026-06-20

## Context
"Backup" is ambiguous. Targets are mature services that handle their own durability; we must not duplicate that by default, but some users may want an extra copy.

## Decision
- **Stack DR (our responsibility):** back up the managed control plane + ledger so the service can be restored. Self-host users back up their own (small) ledger/config; we document how.
- **End-user data durability:** the **target's** responsibility (mature EU/CH providers). Not duplicated by default.
- **Optional user-controlled extra backup:** because the copy engine is idempotent, users may opt in to push a copy to a **destination of their choice** (own object storage, another EU provider, or local), independent of the primary target. Off by default.

## Consequences
- Clear separation; no redundant data handling by default.
- The optional backup reuses the export/portability engine (a §15 benefit).

## Alternatives considered
- Always back up user data ourselves: rejected — duplicates the target, raises cost and data exposure.
