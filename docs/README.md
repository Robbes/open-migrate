# Documentation

All project documentation lives here.

- **`architecture/solution-architecture.md`** — the source of truth. Read this first.
- **`adr/`** — Architecture Decision Records. `0000-template.md` is the template; decisions are
  numbered and append-only (supersede, don't delete).
- **`workplans/`** — numbered build slices (one vertical slice per plan). Each workplan carries a
  **Status block** at the top that agents must keep current at session end; it is the single place
  to see what is done, in flight, or open for that slice.
- **`design/`** — design proposals and per-task ground-truth reports that back the workplans
  (e.g. `domain-sync.md`, `migration-status.md`, the `0011-t*` analyses). These are working
  documents; once a task lands, its outcome is captured in the workplan Status block and the
  design note is kept for the reasoning trail.
- **`stalwart-integration-fix.md`** — the authoritative operational reference for the Stalwart
  v0.16 Testcontainers setup (two-phase startup, provisioning, TLS-only listeners, hard-won rules).
  Read it before touching anything Stalwart-related; do not re-litigate its settled findings.
- **`testing.md`** — canonical testing doc (pyramid, how to run, CI mapping).
- **`deployment.md`** — canonical deployment doc (editions, dev/e2e stack, release controls).
- **`performance.md`** — performance levers and guardrails (do not optimize speculatively).

Operational how-tos already live at the docs root: connector guides (`caldav-sync.md`,
`carddav-sync.md`, `webdav-sync.md`, `imapsync-bulk-sync.md`), `o365-setup.md`, `dns-management.md`,
`rls-guide.md`, `rollback-mechanisms.md`, and the cutover procedures (`cutover-runbook.md`,
`cutover-communication-templates.md`). A dedicated `guides/` / `runbooks/` split can come later if
the root grows unwieldy; don't add empty placeholder directories.

Historical notes are banner-marked in place rather than deleted (workplan/ADR policy): e.g.
`unified-sync.md` (⚠️ superseded by `design/domain-sync.md`) and `dav-integration-status.md`
(📄 resolved in 0007).

## Root Markdown allowlist
To keep the repo root clean, only these `.md` files are allowed there:
`README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`.
Everything else is documentation and belongs in `docs/`.
