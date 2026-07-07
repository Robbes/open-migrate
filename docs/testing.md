# Testing

Canonical doc. Summarises the testing approach; full rationale in `architecture/solution-architecture.md` §22 / §22.1.

## Test pyramid
- **Unit** (vitest): pure logic — reconcile decisions, idempotency keying, special-use/folder mapping, Pattern S/D resolution. No I/O.
- **Connector contract tests**: each source/target adapter against a recorded/standard contract.
- **Integration** (Testcontainers for Node): spin up **Postgres** programmatically; the **Stalwart** JMAP/IMAP target is optional (can use the dev stack from `deploy/compose/dev.yml` or skip). Tests exercise the ledger and, when Stalwart is available, the JMAP writer and IMAP engines.
- **E2E** (docker compose, manual): the real SMB O365 source (read-only, least-privilege) into a disposable target; full slice.

## Running tests locally

### Unit tests (no dependencies)
```bash
pnpm test
```

### Integration tests (requires Docker)
```bash
# Option 1: Postgres only (Testcontainers), shadow-pass tests skipped
pnpm test:integration

# Option 2: Full stack with Stalwart (requires dev stack running)
docker compose -f deploy/compose/dev.yml up -d
# Then run tests with Stalwart env vars pointing to the dev stack
export STALWART_IMAP_HOST=localhost
export STALWART_IMAP_PORT=143
export STALWART_JMAP_URL=http://localhost:8180
export STALWART_JMAP_USERNAME=target@dev.local
export STALWART_JMAP_PASSWORD=change-me-immediately
pnpm test:integration
```

### E2E tests (manual, requires Docker and real O365 credentials)
```bash
# See docs/deployment.md for full setup
```

## Testcontainers setup

Integration tests use Testcontainers to spin up a fresh Postgres instance for each test run. This ensures:
- Tests run in isolation with a clean database
- No conflicts with local development databases
- CI/CD can run tests without pre-configured infrastructure

The Stalwart target is optional:
- If `STALWART_IMAP_HOST` and `STALWART_JMAP_URL` are set, shadow-pass tests run against Stalwart
- If not set, shadow-pass tests are skipped automatically
- This allows running integration tests in environments where Stalwart is not available

## CI mapping (.github/workflows)
- `ci.yml` — `detect-changes -> docs-hygiene (parallel) -> lint -> unit-tests -> integration-tests`; docs-hygiene enforces the root `.md` allowlist and that the canonical docs exist.
- `security-scan.yml` — pnpm audit + Trivy (SARIF) + CycloneDX SBOM; weekly + PR + push + manual; SBOM attached to release tags.
- `e2e.yml` — manual only, on `[self-hosted, linux, arm64]` (the Spark); brings up `deploy/compose/dev.yml`, attaches the runner to the network, applies Drizzle migrations to a fresh DB, runs the slice incl. the idempotency property test, then tears down.
- `no-committed-artifacts.yml` — PR guard against committed `node_modules/`, build outputs, local DBs, and `.env`.

Runners: GitHub-hosted for lint/unit/build and multi-arch image builds; the self-hosted arm64 Spark runner for integration/e2e. The Spark runner executes trusted workflows only.
