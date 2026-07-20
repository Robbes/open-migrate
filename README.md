# Open Migration Stack

Low-maintenance, open-source stack to migrate families and small/medium businesses off US cloud (Microsoft 365, Google, Dropbox) to EU sovereign platforms — starting with **O365 → Soverin / Nextcloud** (Proton later).

- **Idempotent** transfers (re-run safely; no duplicates).
- **Shadow-run** old and new in parallel for as long as you want, then cut over on your schedule.
- **You stay in control** — a clear UI shows what migrates, what doesn't, the status, and any choices to make.
- **Two editions, one core:** self-host it yourself (NAS / mini-PC / Raspberry Pi / Spark) or use it as a managed service.

## Quickstart

### Prerequisites
- Node.js 24+ (or use [Corepack](https://nodejs.org/api/corepack.html))
- pnpm (via `corepack enable pnpm`)
- Docker (for integration tests and dev stack)

### Installation
```bash
# Clone the repository
git clone https://github.com/your-org/open-migrate.git
cd open-migrate

# Install dependencies
corepack enable pnpm
pnpm install
```

### Running Tests
```bash
# Unit tests (no dependencies)
pnpm test

# Integration tests (requires Docker)
pnpm test:integration

# All gates
pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration
```

### Running the Worker (Development)

> **Note:** The worker CLI and dependency injection (ledger, IMAP source, JMAP target) are implemented in `apps/worker/src/build-deps.ts`. Integration tests verify the full stack works end-to-end.

```bash
# Bring up the dev stack (Postgres + Stalwart + Nextcloud)
docker compose -f deploy/compose/dev.yml up -d

# Run worker (uses buildDeps to wire ledger, IMAP, JMAP)
node --loader ts-node/esm apps/worker/src/index.ts --config ./mapping.example.json --once
```

### Configuration
Create a mapping configuration file (see `mapping.example.json`):
```json
{
  "tenantId": "your-tenant-id",
  "mappingId": "inbox-mail",
  "source": {
    "type": "imap-oauth2",
    "host": "outlook.office365.com",
    "port": 993,
    "user": "user@example.onmicrosoft.com",
    "auth": { "kind": "xoauth2", "tokenFromEnv": "O365_ACCESS_TOKEN" }
  },
  "target": {
    "type": "jmap",
    "baseUrl": "https://your-jmap-provider.com/jmap",
    "user": "target@domain.com",
    "auth": { "kind": "basic", "passwordFromEnv": "TARGET_PASSWORD" }
  },
  "schedule": { "cron": "*/15 * * * *" }
}
```

Secrets should be stored in environment variables or a vault, never committed to the repository.

## Documentation
Everything lives in [`docs/`](./docs/). Start with the source of truth: [`docs/architecture/solution-architecture.md`](./docs/architecture/solution-architecture.md). Decisions are recorded in [`docs/adr/`](./docs/adr/).

### Key Documentation
- **Architecture**: [`docs/architecture/solution-architecture.md`](./docs/architecture/solution-architecture.md)
- **Testing Guide**: [`docs/testing.md`](./docs/testing.md)
- **Self-host Quickstart**: [`docs/selfhost-quickstart.md`](./docs/selfhost-quickstart.md)
- **Stalwart Integration**: [`docs/stalwart-integration-fix.md`](./docs/stalwart-integration-fix.md)
- **Workplans**: [`docs/workplans/`](./docs/workplans/)
- **Decision Records**: [`docs/adr/`](./docs/adr/)

## Status
Active development, pre-release. License: Apache-2.0 (see `LICENSE`).

The **migration core** is done and property-tested for idempotency: O365 → JMAP/IMAP-DAV mail,
plus calendar/contacts/files domains (worker `runAllDomains` orchestration) and the cutover
machine. The **managed edition** control plane is well underway — tenant isolation is enforced at
runtime (Postgres RLS with a non-owner role, proven cross-tenant at the SQL and HTTP layers), the
API persists real data, Trigger.dev jobs run the real mail sync, and usage metering accrues from
real runs. Still in flight for managed: billing/payment end-to-end, the web UI verified against the
API, and the operator compose stack. The **self-host edition** (a single-tenant NAS/Pi appliance
bundling Postgres) is now packaged — a startup migration runner, a real entrypoint, and a
bundled-Postgres compose stack (`deploy/selfhost/`, see the
[quickstart](./docs/selfhost-quickstart.md)); the on-a-Docker-host build/verify and the
restart-resume acceptance gate are the remaining steps. See
[`docs/workplans/`](./docs/workplans/) for the per-slice Status blocks.

## Contributing
See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md) (guidance for coding agents).
