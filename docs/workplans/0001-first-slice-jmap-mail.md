# Workplan 0001 — First buildable slice: O365 → JMAP mail (one-way shadow)

## Status — 2026-07-07 (update this block at the end of every session)

| Task | Status | Evidence |
|---|---|---|
| T0 dev stack + ledger | **Done** | `feat/t0-sql-ledger-cursorstore`; ledger integration tests green; SqlLedger + SQL CursorStore; Stalwart provisioned via two-phase Testcontainers |
| T1 core model + interfaces | **Done** (pre-built) | unit tests in `@openmig/shared` / `@openmig/core` |
| T2 IMAP source | **Done** | integration-tested against Stalwart (IMAPS 993; cursor `UIDVALIDITY:UIDNEXT`; client-side UID filtering — see fix doc) |
| T3 JMAP target writer | **Done** | integration-tested; accountId resolved by configured email with hard-fail on mismatch (see fix doc) |
| T4 shadow engine — **THE GATE** | **Done ✅** | idempotency + delta property tests green against Stalwart (11/11 `test:integration`) |
| T5 Pattern-S shared mailbox | **Open — verify first** | no test evidence found; audit before implementing |
| T6 croner wiring in `schedule()` | **Open — verify first** | `runOnce` + `SingleFlight` pre-built/unit-tested; croner tick wiring + short integration run outstanding |
| T7 worker CLI entrypoint | **Open — verify first** | config loader pre-built/unit-tested; CLI (`--once`/scheduled) outstanding |
| T8 docs + ADRs | **Partial** | `stalwart-integration-fix.md` authoritative and current; `testing.md`/`README.md` synced 2026-07-07; README quickstart unverified |
| T9 reindex on real connector | **Done ✅** | `apps/worker/src/jmap-reindex.integration.test.ts`; `TargetReindexer.listEntries()` implemented; mailbox cleanup isolation pattern; PR #19 |

Hard-won operational truth for this slice lives in `docs/stalwart-integration-fix.md`
(two-phase startup, TLS-only listeners — **no plaintext 143** — accountId rule, cursor rules,
RocksDB lock rules). Do not re-litigate its settled findings.

> Read `AGENTS.md` and `docs/architecture/solution-architecture.md` (source of truth) first.
> This plan is **JMAP-first (ADR-0018)**. Build it as a thin **vertical slice**: one mailbox's
> mail flowing end-to-end, idempotently, in shadow mode — before any breadth.

## Definition of Done (the gate)
A one-way, **non-destructive mail mirror** from an O365 source mailbox to a **JMAP target**
(Stalwart locally), including the **Sent** folder and **one Pattern-S shared mailbox**, driven by
the **in-process (croner) scheduler**, with the **ledger** enforcing idempotency.

The acceptance gate is the **idempotency property test**: run the full sync twice against a fresh
target → the second run creates **zero** new items and the target state is **identical** (no
duplicates; folders, flags, and `Sent` preserved). All gates green: `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm test:integration`.

## In scope
- **O365 mail source** over **IMAP+OAuth2 (XOAUTH2)**, implemented provider-agnostically so it also
  speaks plain IMAP `LOGIN` — CI exercises it against **Stalwart-as-source** (no O365 secrets in CI).
- **JMAP target writer** (jmap-jam) → Stalwart: session discovery, ensure `Mailbox` (incl. **Sent**
  role / special-use), `Email/set` import, keyword/flag mapping (`$seen/$flagged/$draft/$answered`),
  preserve `receivedAt` (internaldate).
- **Ledger** idempotency on `UNIQUE(tenant_id, mapping_id, natural_key_hash)` + `content_hash`;
  **non-destructive** (source deletions are logged as drift, never propagated).
- **One-way shadow pass** with a per-folder **cursor** for incremental delta.
- **One Pattern-S shared mailbox** → a dedicated target mailbox (same engine, second mapping).
- **In-process scheduler** (croner) behind the `Scheduler` interface, with **single-flight**.
- Minimal **worker CLI** entrypoint + **example mapping config** (no secrets).
- **Tests:** unit (natural key + content hash + flag mapping), integration (Testcontainers:
  Postgres + Stalwart), the idempotency property test.

## Out of scope (later slices)
- The **IMAP/DAV target** family (Soverin/openDesk) → **slice 0002** (same engine + `imapsync`/DAV writer).
- Calendar / contacts / files; CardDAV / vdirsyncer / rclone; JMAP for Calendars/Contacts/Files.
- Microsoft **Graph rich extractor**; **Pattern-D** distribution lists.
- Two-way sync; cutover; **web UI**; managed edition (Trigger.dev, Postgres+RLS, multi-tenant).
- Real O365 credentials in CI (manual/secret-gated e2e only).

## Tasks (one small PR per task; keep gates green)

### T0 — Dev stack + ledger bring-up
Bring up `deploy/compose/dev.yml` (Postgres + Stalwart + Nextcloud). Provision Stalwart for tests:
set hostname/domain (`dev.local`) and create two accounts — `source@dev.local` and
`target@dev.local` — via the JMAP management API / admin (scripted, using the recovery admin from
the compose env). Finalize `packages/ledger`: align `schema.ts` with `migrations/0001_init.sql`;
make `pnpm db:migrate` apply cleanly to **Postgres and SQLite**; expose a typed ledger client with an
idempotent `recordIfAbsent(naturalKeyHash, contentHash, …)`.
**Acceptance:** `pnpm db:migrate` green on a fresh DB; an integration test inserts a ledger row and a
re-insert of the same `natural_key_hash` is a no-op returning the existing row; Stalwart has
`source@`/`target@` accounts reachable.

### T1 — Core model + interfaces (the seams)
In `packages/shared` / `packages/core`: define the normalized **MailItem** (Message-ID, folder +
special-use role, flags, internaldate, size, raw RFC822 reference) and the key functions
(`naturalKey = Message-ID`; `contentHash = sha256(normalized headers + body)`). Define interfaces:
`SourceConnector` (`listFolders`, `listSince(cursor)`, `fetch`), `TargetWriter` (`ensureMailbox`,
`upsertEmail → targetId`), `Scheduler`, `Ledger`.
**Acceptance:** compiles; unit tests for natural-key + content-hash stability (same input → same hash).

### T2 — O365 mail source (IMAP+OAuth2, read-only)
In `packages/connectors`: IMAP client supporting **XOAUTH2** (O365) and **LOGIN** (dev). Enumerate
folders with special-use detection (RFC 6154: INBOX, `\Sent`, `\Drafts`, …); list messages (UID,
Message-ID, flags, internaldate); fetch full RFC822. Read-only; track a cursor (UIDVALIDITY + UIDNEXT).
**Acceptance:** integration test seeds messages into `source@dev.local` via IMAP `APPEND`; the
connector lists folders + messages and fetches RFC822 byte-equal to what was seeded.

### T3 — JMAP target writer (mail)
In `packages/connectors` / `packages/engines`: jmap-jam client against Stalwart. Session discovery
(`/.well-known/jmap`); `Mailbox/get` + ensure (create if missing, map **Sent** role); `Email/set`
create from RFC822 (blob upload + import) with **ledger-gated idempotency** (check
`natural_key_hash` + `content_hash` before create; skip if present and unchanged); map keywords/flags;
preserve `receivedAt`.
**Acceptance:** integration test writes N messages to `target@dev.local`; a re-run creates 0; messages
land in the correct mailboxes incl. Sent; flags preserved; reading back via JMAP matches the source.

### T4 — One-way shadow engine + ledger wiring (THE GATE)
In `packages/core`: orchestrate a mapping pass — `source.listSince(cursor)` → per item compute keys →
`ledger.recordIfAbsent` → `target.upsertEmail` → persist cursor. One-way, **non-destructive**;
surface source deletions as logged drift only.
**Acceptance:** **idempotency property test** — run the pass twice on a fresh target: run 1 mirrors the
source set exactly; run 2 = 0 creates, identical state. **Delta test** — append one source message,
re-run → exactly 1 create. Both live in `test:integration`.

> **Status (pre-built):** `runShadowPass` is implemented in `@openmig/core` and covered by **unit** property
> tests (idempotency, delta, lost-ledger recovery, **cursor-based incremental passes, lost-cursor re-scan**)
> using in-memory fakes. The loop also supports an optional `CursorStore` (persisted per folder, only after
> the folder completes). Remaining for the agent: wire the real IMAP source (T2) + JMAP target (T3) + SQL
> ledger (T0), implement a SQL-backed `CursorStore` and have the connectors honor cursors
> (IMAP `UIDVALIDITY:UIDNEXT` via `encodeImapCursor`; JMAP state strings), then re-run the same assertions
> against Stalwart in `test:integration`.

### T5 — Pattern-S shared mailbox (one)
Add a second mapping for a shared mailbox (`shared@dev.local` → dedicated `target-shared@dev.local`);
reuse the same engine. (For O365 the shared mailbox is reached per ADR-0006; in dev it is just another
IMAP account.)
**Acceptance:** the shared mailbox's mail incl. its Sent mirrors idempotently to the dedicated target.

### T6 — In-process scheduler (croner)
In `packages/scheduler`: a croner impl of `Scheduler` that triggers the pass on a configurable
interval, with a **single-flight** lock (coalesce overlapping triggers).
**Acceptance:** unit test with a fake clock shows scheduled triggers and coalesced overlaps; a short
integration run performs ≥2 passes idempotently.

> **Status (pre-built):** `InProcessScheduler.runOnce` with **single-flight** coalescing (`SingleFlight`) is implemented in `@openmig/scheduler` and unit-tested. Remaining for the agent: wire **croner** in `schedule(...)` (each tick via the same single-flight) and add the short integration run.

### T7 — Worker CLI entrypoint
In `apps/worker` (and/or `apps/selfhost`): a CLI that runs `--once` or scheduled mode from a **mapping
config file** (source IMAP/OAuth2 + target JMAP; secrets via env, never committed). Ship
`mapping.example.json` with placeholders only.
**Acceptance:** `pnpm --filter @openmig/worker dev -- --once --config ./mapping.example.json` runs a full
pass against the dev stack.

> **Status (pre-built):** the dependency-free typed config loader/validator (`parseMappingConfig` / `parseMappingConfigJson` in `@openmig/shared`) is implemented and unit-tested (valid example, optional fields, and path-specific validation errors). Remaining for the agent: the CLI entrypoint + file read + `--once`/scheduled wiring.

### T8 — Docs + ADRs
Update `README.md` quickstart (bring up stack → run the slice) and `docs/testing.md` (the idempotency
property test); add an ADR if a decision crystallizes (e.g. **ADR-0019: mail natural-key = Message-ID
+ content-hash normalization rules**). Keep docs-hygiene green.
**Acceptance:** quickstart works from a clean clone on the Spark; gates green.

### T9 — Reindex / adopt from target (lost-ledger recovery) [ADR-0020]
Make idempotency survive a **lost ledger** (e.g. a fresh reinstall with no backup). (a) In the
`TargetWriter`, add a **create-if-absent by natural key** existence check (JMAP `Email/query` on
header `Message-ID`; IMAP `SEARCH HEADER Message-ID`) layered over the ledger fast-path. (b) Add a
**reindex** routine that scans the target, harvests `Message-ID → target id` (+ content hash), and
repopulates the ledger; **auto-run it when the ledger is empty but the target is non-empty**.
**Acceptance:** after a full sync, **wipe the ledger**, then reindex + a normal pass creates **0**
new messages (no duplicates); a subsequent fresh delta still creates exactly the new ones.
Integration test on Stalwart.

> **Status (pre-built):** `reindexFromTarget` is implemented in `@openmig/core` and unit-tested via `MemoryTarget`/`MemoryLedger`. Remaining for the agent: implement `TargetReindexer.listEntries` on the real JMAP/IMAP connector and add the Stalwart integration test.

## Conventions & gotchas
- **arm64 lockfile:** the committed `pnpm-lock.yaml` was generated on x64; if a native optional
  mismatches on the Spark, run a plain `pnpm install` once to reconcile, then commit.
- **No committed artifacts** (`node_modules`/`dist`/`build`/`.env`) — the PR guard enforces this.
- **Stalwart in dev:** the image's built-in healthcheck targets TLS/443 and is disabled in the compose;
  the e2e workflow polls `stalwart:8080`. JMAP + DAV are on the HTTP API (8080). **Stalwart v0.16
  binds TLS listeners only — IMAP is IMAPS on 993 (self-signed cert in tests; `rejectUnauthorized:
  false`); there is no plaintext 143.** See `docs/stalwart-integration-fix.md`.
- **Secrets:** none for this slice — everything runs against local Stalwart. Real O365 is
  manual/secret-gated only.
- Small PRs, each green on lint + unit + integration; the arm64 e2e job is **manual** on the Spark.

## Slice roadmap (context, not this slice)
- **0001 (this):** O365 → JMAP mail, one-way shadow, idempotent.
- **0002:** IMAP/DAV **target** family (Soverin/openDesk) via `imapsync` + DAV writer — same engine.
- **0003:** contacts (CardDAV/vdirsyncer) and calendar; then files.
- Later: Graph rich extractor, discovery/drift + decision-queue UI, cutover, managed edition.