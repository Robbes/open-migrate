# OpenHands start prompt — slice 0001

Paste the block below into OpenHands as the initial task. It assumes the repo is cloned and
`.openhands/setup.sh` has run (it installs deps and self-bootstraps Node 24 if the sandbox lacks
it). The agent has docker-socket rights, so it brings the dev stack up itself.

```text
You are building in this repository. Read AGENTS.md and docs/architecture/solution-architecture.md
(the source of truth), then follow docs/workplans/0001-first-slice-jmap-mail.md.

Goal: ship the first vertical slice — a one-way, non-destructive, idempotent MAIL mirror from an
O365 source mailbox to a JMAP target (Stalwart locally), including Sent and one Pattern-S shared
mailbox, driven by the in-process croner scheduler, with the ledger enforcing idempotency.
JMAP is the primary target (ADR-0018); the O365 source stays IMAP+OAuth2/Graph.

Already pre-built and unit-proven — build against it, do NOT rewrite: the ports and pure helpers
in @openmig/shared (ports.ts, hash, keywords, specialUse, cursor codec, config loader), the
reconcile loop runShadowPass and reindexFromTarget in @openmig/core (property tests prove
idempotency, delta, lost-ledger recovery, and cursor-based incremental passes), and SingleFlight +
InProcessScheduler.runOnce in @openmig/scheduler. Your work is the stack-bound half: SqlLedger (T0)
and a SQL-backed CursorStore (T0 or T4), the IMAP source (T2), the JMAP target writer (T3), croner
wiring in schedule() (T6), the worker CLI (T7), reindex on the real connector (T9), and porting the
same property assertions to test:integration against Stalwart. The unit tests are the spec.

Work task by task, T0 → T9, in order. For each task:
1. Implement the smallest change that satisfies its Acceptance criteria.
2. Write/keep the tests named in the task (unit + integration). The idempotency property test in
   T4 is the acceptance gate — do not weaken or skip it.
3. Run pnpm lint, pnpm typecheck, pnpm test, and pnpm test:integration. All must pass.
4. Open one focused PR per task, with a short description that references the task ID.

Hard rules (from AGENTS.md): idempotency is sacred; non-destructive by default (never delete or
overwrite on the target; log source deletions as drift); never commit secrets or build artifacts;
the self-host path must keep working; Apache-2.0 headers on source files; any architectural
decision -> add or supersede an ADR in docs/adr/ and reference it. When optimizing, follow the
prioritized levers in docs/performance.md — do not optimize speculatively.

Environment & testing: bring up the stack yourself with
`docker compose -f deploy/compose/dev.yml up -d` (Postgres 18 + Stalwart v0.16.10 + Nextcloud 34).
Tests run against Stalwart — account source@dev.local is seeded via IMAP APPEND, target@dev.local
is written via JMAP — so no O365 credentials are needed in CI. If the arm64 pnpm lockfile
mismatches a native optional, run a plain `pnpm install` once and commit the result.

Start with T0 (dev stack + ledger bring-up). Before writing code, post a 5–8 line plan for T0 and
the exact files you intend to add or change. Ask me only if a decision would change the
architecture; otherwise proceed and record decisions as ADRs.
```
