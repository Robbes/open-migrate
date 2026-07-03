# Performance & resource notes

The dominant runtime cost of a migration is **connector I/O** (network to the source and target) and
the **target / ledger databases**. Most performance levers therefore live in the connectors and the
SQL ledger, which run against the live stack. This doc records what is already optimized in the
stack-independent core, and the prioritized levers for the agent to apply (and measure) with real data.

## Applied in the core (unit-verified, no new deps)
- **Bounded-concurrency reconcile** — `runShadowPass` processes per-folder items in parallel via
  `mapWithConcurrency` up to `concurrency` (default 4; configurable on `ReconcileDeps` / `MappingConfig`).
  Raises throughput on I/O-bound fetch/write and **caps peak memory** to ~`concurrency` message bodies
  in flight. Folders run sequentially; items in a folder have distinct Message-IDs, so it is race-free.
- **Fail-fast concurrency** — on the first worker error, `mapWithConcurrency` stops scheduling new work
  (no wasted fetches/writes), lets in-flight work settle, then rejects with that first error.
- **Ledger fast-path before fetch** — a message already in the ledger is skipped without downloading
  its body.
- **Body-free recovery** — `reindexFromTarget` adopts existing target items into the ledger from a
  metadata-only listing (no RFC822 fetch). The recommended recovery flow (reindex, then a pass) thus
  avoids re-downloading bodies; orchestrate reindex automatically when the ledger is empty but the
  target is not (ADR-0020 / workplan T9).

## High-value levers for the agent (need the live stack / real libraries)
1. **JMAP request batching (target, T3)** — the biggest JMAP lever: send many `Email/set` creates (and
   `Mailbox/get`) per HTTP request (e.g. 50–100), not one call per message. Pair with HTTP keep-alive /
   a connection pool. Drastically cuts round-trips.
2. **IMAP pipelining & connection reuse (T2 / slice 0002)** — reuse one authenticated connection per
   mailbox; pipeline `APPEND`s; use `CONDSTORE`/`QRESYNC` + the UID cursor for cheap incremental scans
   instead of full re-listing.
3. **Incremental cursors (T4 follow-up)** — persist the per-folder cursor (`encodeImapCursor`) so
   steady-state passes process only changed items, eliminating full re-scans (and the N per-item ledger
   lookups that go with them). *Loop side applied in core:* `runShadowPass` takes an optional
   `CursorStore` and persists per-folder cursors after each successful folder. Remaining: connector
   cursor support (IMAP `UIDVALIDITY:UIDNEXT`, JMAP state strings) + a SQL-backed `CursorStore`.
4. **Batched ledger lookups (trade-off)** — replace N per-item `ledger.find` calls on a full scan with
   one bulk fetch of known natural-key-hashes into an in-memory `Set`. Large round-trip savings, but the
   Set grows with mailbox size (≈ tens of MB at ~1M messages). Worth it for typical family/SMB mailboxes;
   scope/page it for very large accounts. Largely moot once incremental cursors (#3) land. Decide with data.
5. **SQL ledger efficiency (T0)** — `INSERT … ON CONFLICT DO NOTHING`, prepared statements, a covering
   index on `(tenant_id, mapping_id, natural_key_hash)`, and batched multi-row inserts during reindex.
6. **Streaming large bodies (contract change)** — `RawMessage.rfc822` currently buffers the whole
   message; for large attachments, stream source→target to cut peak memory. Needs a streaming variant of
   `SourceConnector.fetch` / `TargetWriter.upsertEmail`.
7. **Streaming `listSince` (contract change)** — return items as an async iterable instead of a
   materialized array, so very large folders do not hold all item metadata at once.
8. **Parallel reindex** — consume `TargetReindexer.listEntries` with bounded concurrency (serial iterator
   pulls, parallel ledger writes). Lower priority — reindex is a rare maintenance op.

## Guardrails
- Keep concurrency **bounded**: servers throttle, and memory scales with in-flight bodies. Default modest;
  make it configurable per mapping.
- Preserve the idempotency / non-destructive invariants under any optimization — the property tests
  (`packages/core/src/reconcile.test.ts`, `reindex.test.ts`) are the gate.
