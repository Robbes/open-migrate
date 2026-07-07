# Documentation

All project documentation lives here.

- **`architecture/solution-architecture.md`** — the source of truth. Read this first.
- **`adr/`** — Architecture Decision Records. `0000-template.md` is the template; decisions are
  numbered and append-only (supersede, don't delete).
- **`workplans/`** — numbered build slices (one vertical slice per plan). Each workplan carries a
  **Status block** at the top that agents must keep current at session end; it is the single place
  to see what is done, in flight, or open for that slice.
- **`stalwart-integration-fix.md`** — the authoritative operational reference for the Stalwart
  v0.16 Testcontainers setup (two-phase startup, provisioning, TLS-only listeners, hard-won rules).
  Read it before touching anything Stalwart-related; do not re-litigate its settled findings.
- **`testing.md`** — canonical testing doc (pyramid, how to run, CI mapping).
- **`deployment.md`** — canonical deployment doc (editions, dev/e2e stack, release controls).
- **`performance.md`** — performance levers and guardrails (do not optimize speculatively).

Planned (not yet created): `guides/` (how-tos: setup, connectors, editions) and `runbooks/`
(operational procedures, e.g. the cutover runbook). Create them when the first real content
exists — do not add empty placeholders.

## Root Markdown allowlist
To keep the repo root clean, only these `.md` files are allowed there:
`README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`.
Everything else is documentation and belongs in `docs/`.
