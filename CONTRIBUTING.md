# Contributing

## Documentation lives in `docs/`
All documentation goes under `docs/`. The **only** Markdown files allowed in the repo root are:

`README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `CODE_OF_CONDUCT.md`

(`LICENSE` has no extension.) Anything else — design, guides, runbooks, notes — belongs in `docs/`. A CI check may enforce this allowlist.

## Architecture Decision Records (ADRs)
Significant decisions are captured as ADRs in `docs/adr/`.
- Copy `docs/adr/0000-template.md` to the next number, e.g. `0011-my-decision.md`.
- Status flow: Proposed -> Accepted -> (later) Superseded by `00xx`.
- Keep them short (about one page): Context, Decision, Consequences, Alternatives.
- Reference the ADR id from code/PRs when relevant.

## Commits & branches
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`...).
- Short-lived feature branches; PRs into `main`; CI green before merge.

## Code
- TypeScript, pnpm workspaces. Apache-2.0 license header on source files.
- Keep `packages/` and `apps/selfhost` free of managed-only hard dependencies (self-host must work).
- Add/keep tests; idempotency and non-destructive invariants are mandatory (see AGENTS.md).

## Secrets
Never commit secrets. Use `.env` (gitignored, see `.env.example`) and a vault.
