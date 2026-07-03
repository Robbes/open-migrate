# Testing

Canonical doc. Summarises the testing approach; full rationale in `architecture/solution-architecture.md` §22 / §22.1.

## Test pyramid
- **Unit** (vitest): pure logic — reconcile decisions, idempotency keying, special-use/folder mapping, Pattern S/D resolution. No I/O.
- **Connector contract tests**: each source/target adapter against a recorded/standard contract.
- **Integration** (Testcontainers for Node): spin up Postgres + **Stalwart** (JMAP + IMAP/DAV reference target) + Nextcloud programmatically; exercise the JMAP writer plus the IMAP/DAV engines (imapsync/vdirsyncer/rclone) and the ledger.
- **E2E** (docker compose, manual): the real SMB O365 source (read-only, least-privilege) into a disposable target; full slice.

## The two tests that matter most
- **Idempotency property test:** run a sync twice and assert convergence — no duplicates, identical end state.
- **Migration upgrade-path test:** migrate from the previous release (N-1, and one older) to N on representative data, on **both Postgres and SQLite**; assert no data loss and that the **ledger still enforces idempotency afterwards** (post-migration, run a sync twice -> still converges). Also: fresh-install on both backends, idempotent re-run of each migration, destructive-change lint (Atlas), and a migration-lock test.

## CI mapping (.github/workflows)
- `ci.yml` — `detect-changes -> docs-hygiene (parallel) -> lint -> unit-tests -> integration-tests`; docs-hygiene enforces the root `.md` allowlist and that the canonical docs exist.
- `security-scan.yml` — pnpm audit + Trivy (SARIF) + CycloneDX SBOM; weekly + PR + push + manual; SBOM attached to release tags.
- `e2e.yml` — manual only, on `[self-hosted, linux, arm64]` (the Spark); brings up `deploy/compose/dev.yml`, attaches the runner to the network, applies Drizzle migrations to a fresh DB, runs the slice incl. the idempotency property test, then tears down.
- `no-committed-artifacts.yml` — PR guard against committed `node_modules/`, build outputs, local DBs, and `.env`.

Runners: GitHub-hosted for lint/unit/build and multi-arch image builds; the self-hosted arm64 Spark runner for integration/e2e. The Spark runner executes trusted workflows only.
