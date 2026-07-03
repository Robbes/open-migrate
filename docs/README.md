# Documentation

All project documentation lives here.

- **`architecture/solution-architecture.md`** - the source of truth. Read this first.
- **`adr/`** - Architecture Decision Records. `0000-template.md` is the template; decisions are numbered and append-only (supersede, don't delete).
- **`guides/`** - how-tos (setup, connectors, editions).
- **`runbooks/`** - operational procedures (e.g., the cutover runbook).

## Root Markdown allowlist
To keep the repo root clean, only these `.md` files are allowed there:
`README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`.
Everything else is documentation and belongs in `docs/`.
