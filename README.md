# Open Migration Stack

Low-maintenance, open-source stack to migrate families and small/medium businesses off US cloud (Microsoft 365, Google, Dropbox) to EU sovereign platforms — starting with **O365 → Soverin / Nextcloud** (Proton later).

- **Idempotent** transfers (re-run safely; no duplicates).
- **Shadow-run** old and new in parallel for as long as you want, then cut over on your schedule.
- **You stay in control** — a clear UI shows what migrates, what doesn't, the status, and any choices to make.
- **Two editions, one core:** self-host it yourself (NAS / mini-PC / Raspberry Pi / Spark) or use it as a managed service.

## Documentation
Everything lives in [`docs/`](./docs/). Start with the source of truth: [`docs/architecture/solution-architecture.md`](./docs/architecture/solution-architecture.md). Decisions are recorded in [`docs/adr/`](./docs/adr/).

## Status
Early development. License: Apache-2.0 (see `LICENSE`).

## Contributing
See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md) (guidance for coding agents).
