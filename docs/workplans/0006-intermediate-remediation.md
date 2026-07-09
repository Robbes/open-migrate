# Workplan 0006 — Intermediate remediation: repo integrity & findings outside the plan

## Status — PROPOSED, ⚠️ AWAITING OWNER VALIDATION (do not execute until approved)

| Item | Status | Owner decision |
|---|---|---|
| A — Test-selection gap (17 test files never run) | ⬜ Proposed | approve / reject |
| B — Docs case collision `DEPLOYMENT.md` vs `deployment.md` | ⬜ Proposed | approve / reject |
| C — Workplan & docs integrity (0003/0004/0005 status, broken links, stale README) | ⬜ Proposed | approve / reject |
| D — Root dependency & shim cleanup (`mollie-api-node`, stale `.d.ts`) | ⬜ Proposed | approve / reject |
| E — CI hardening (self-hosted runner on `pull_request`, unpinned actions) | ⬜ Proposed | approve / reject |
| F — Stray `. agents/` directory (name contains a space) | ✅ Done 2026-07-09 | approved (b): relocated to `.agents/skills/caveman.md`, referenced from AGENTS.md (agent-neutral) |
| G — Web framework decision: `migration/nextjs-15` branch vs Vite on `main` | 🔶 Recommendation recorded | recommended (b) stay on Vite; owner confirms branch deletion |
| H — Compose duplication & Postgres version drift (root vs `deploy/compose`) | ⬜ Proposed | approve / reject |
| I — Re-enable `no-unused-vars` lint rule | ⬜ Proposed | approve / reject |
| J — Worker CLI config-path bug | ⬜ Proposed | approve / reject |

> This workplan was produced by an assessment session on 2026-07-09 (clean clone of `main`,
> `f1acd4a`). It collects **verified findings that fall outside the architecture/feature plans**.
> Per the owner's instruction it must be **validated by the owner item-by-item before an agent
> executes it**. Every finding below quotes its evidence; re-verify paths before editing
> (AGENTS.md: don't trust paths blindly).

## Why this plan exists
The feature workplans (0007+) assume the test suite tells the truth and the docs don't mislead
agents. Several findings undermine that assumption — most critically, **the core idempotency
property tests are currently not executed by any test command**. Fixing these first makes every
subsequent workplan trustworthy.

---

## A — CRITICAL: test-selection gap — 17 test files match no vitest project

**Evidence.** `vitest.config.ts` defines exactly three projects with includes
`**/*.unit.test.ts`, `**/*.integration.test.ts`, `**/*.e2e.test.ts`. Root scripts run
`vitest run --project unit --passWithNoTests` (and `--project integration`). Files named plain
`*.test.ts`/`*.test.tsx` match **none** of the three patterns, so they are silently skipped —
locally and in CI (`ci.yml` unit job runs `pnpm test -- --coverage`). Affected files:

- `packages/core/src/reconcile.test.ts` — **the idempotency/delta/lost-ledger property tests** (hard rule 1 calls these sacred)
- `packages/core/src/reindex.test.ts`, `packages/core/src/unified-sync.idempotency.test.ts`
- `packages/shared/src/hash.test.ts`, `config.test.ts`, `cursor.test.ts`, `keywords.test.ts`, `specialUse.test.ts`, `concurrency.test.ts`, `index.test.ts`
- `packages/ledger/src/ledger.test.ts`, `index.test.ts`, `rls.test.ts` (also: its header says `pnpm test:rls`, a script that does not exist in the root `package.json`)
- `packages/connectors/src/imap-source.test.ts`, `packages/scheduler/src/single-flight.test.ts`
- `apps/api/src/__tests__/billing-service.test.ts`, `apps/web/src/__tests__/Dashboard.test.tsx`

**Consequence.** Workplan status blocks cite "unit tests green" for suites that no longer run.
`--passWithNoTests` masks the hole (AGENTS.md hard rule 9: never mask).

**Fix (proposed).**
1. Rename each file to the correct suffix: pure-logic tests → `*.unit.test.ts`;
   DB-backed tests (`rls.test.ts`) → `*.integration.test.ts`. Prefer renaming over widening the
   globs so the unit/integration split stays explicit.
2. Run `pnpm test` and `pnpm test:integration`; **fix whatever surfaces** (these files have not
   gated changes for some time — assume drift; quote failures verbatim before fixing).
3. Add a guard so this cannot recur: a tiny unit test or CI step that fails when a file matching
   `*.test.ts?(x)` exists that matches no project include.
4. Remove `--passWithNoTests` from `test` and `test:integration` (keep it only for `test:e2e`
   while `test/e2e` is empty).

**Acceptance.** All listed files execute in `pnpm test`/`pnpm test:integration`; gates green;
guard in place; CI run linked in this status block.

---

## B — Docs case collision: `docs/DEPLOYMENT.md` and `docs/deployment.md` both tracked

**Evidence.** `git ls-files | grep -i deployment` returns both. On case-insensitive filesystems
(Windows, macOS — the owner develops on Windows 11) `git clone` warns and materializes only one
file. Contents differ: lowercase is the canonical short doc; uppercase is a longer guide added
with the 0005 work. CI docs-hygiene requires `docs/deployment.md` to exist. Symptom on affected
checkouts: `git status` permanently shows a phantom `M docs/DEPLOYMENT.md` that cannot be
discarded — agents must not commit or "fix" it; resolve via this item only.

**Fix (proposed).** Merge any still-valuable content from `DEPLOYMENT.md` into `deployment.md`
(canonical, per its own header), then `git rm --cached "docs/DEPLOYMENT.md"` (use `--cached` on a
case-insensitive checkout), commit from one machine. Add a CI docs-hygiene step that fails when
two tracked paths differ only by case (`git ls-files | sort -f | uniq -di`).

**Acceptance.** One tracked deployment doc; fresh clone on Windows shows no collision warning;
CI guard rejects future case collisions.

---

## C — Workplan & docs integrity (agents are being misled)

**Evidence.**
1. `docs/workplans/0003-caldav-carddav-webdav.md` lists engines/writers under "Completed Tasks",
   but `packages/core/src/unified-sync.ts` says in its header *"NOTE: This is a stub
   implementation"* and all four `sync*` functions return zeros; the ledger has **no item-type
   support** (`packages/ledger/migrations/` contains only `0001_init.sql` and
   `0002_multi_tenant_rls.sql`); the worker CLI wires **mail only** (`apps/worker/src/build-deps.ts`).
2. `docs/workplans/0004-cutover-dns.md` contradicts itself: the header says *"Phase 3 -
   IN_PROGRESS"*, the body says *"Phase 3 ✅ COMPLETED"*, and Success Criteria still show
   Phases 2–3 as pending. Phase 4 (integration) is genuinely open.
3. The actual **workplan 0005 document was deleted** (commit `f1acd4a` removed
   `.agents_tmp/PLAN.md`); only `0005-implementation-summary.md` survives and it links to the
   deleted file and to ADR filenames that don't exist (`0004-orchestration-strategy.md`,
   `0010-persistence.md` — actual names differ).
4. Root `README.md` is stale: the worker note says dependency wiring is pending (it exists:
   `apps/worker/src/build-deps.ts`), and the README's mapping-config JSON example does not match
   the actual schema in `packages/shared/src/config.ts` / `mapping.example.json`
   (`type: "imap"`+inline token vs `type: "imap-oauth2"`+`tokenFromEnv`).
5. AGENTS.md instructs agents to **trust workplan status blocks** — so these inaccuracies
   propagate into future sessions.

**Fix (proposed).**
- Correct the Status blocks of 0003 and 0004 to verified reality (0003: models/hash/interfaces/
  writers exist, orchestration+sources+ledger-extension open → superseded by workplan 0007;
  0004: Phases 1–3 unit-level done, Phase 4 open → superseded by workplan 0009).
- Restore the 0005 plan from git history (`git show f1acd4a^:.agents_tmp/PLAN.md`) as
  `docs/workplans/0005-managed-edition.md`; fix links in the summary; mark honest status
  (schema/RLS SQL done; API routes are TODO shells — see 0011).
- Refresh README quickstart to the real config schema and current worker state.

**Acceptance.** Every workplan Status block matches code (spot-checked with the evidence above);
no dead links in `docs/workplans/`; README example parses with `parseMappingConfig`.

---

## D — Root dependency & shim cleanup

**Evidence.** Root `package.json` declares `mollie-api-node: ^1.4.0` (ancient major; current is
v4 under a different name) while the API app correctly uses `@mollie/api-client: ^4.6.0`.
`apps/api/src/types/mollie-api-node.d.ts` hand-declares types for the module nobody imports.
Root also carries `imap-simple`/`@types/imap-simple` (ADR-0022 already records the imapflow
migration path — no action beyond placement).

**Fix (proposed).** Verify with `grep -r "from 'mollie-api-node'"` that nothing imports it;
remove the root dep and the stale `.d.ts`. Move `imap-simple` (and its types) from the root
manifest into `packages/connectors` where it is actually consumed, honoring workspace hygiene.
Regenerate the lockfile; `--frozen-lockfile` green.

**Acceptance.** `pnpm install --frozen-lockfile`, lint, typecheck, tests green with the root
manifest free of unused deps.

---

## E — CI hardening (supply chain)

**Evidence.** `ci.yml` runs **all** jobs (`lint`, `unit`, `integration`) on `runs-on: self-hosted`
and triggers on `pull_request`. AGENTS.md safety notes: the Spark runner has docker socket +
root, *trusted workflows only*. ADR-0009 targets a **public** monorepo — once public, an external
fork PR would execute on that runner. Several actions are unpinned (`pnpm/action-setup@v4`,
`actions/setup-node@v4` carry `TODO: pin` comments). The architecture (§22) prescribes
GitHub-hosted runners for lint/unit and the Spark only for integration/e2e.

**Fix (proposed).** Move lint+unit jobs to `ubuntu-latest`; keep integration/e2e on the Spark but
gate them (run on `push` to `main` and on PRs from branch authors with write access, e.g.
`github.event.pull_request.head.repo.full_name == github.repository`). Pin the two actions to
commit SHAs. Document the policy in `docs/testing.md`.

**Acceptance.** A PR from a fork cannot reach the self-hosted runner; all actions SHA-pinned;
pipeline still green end-to-end.

---

## F — Stray `. agents/` directory (leading-dot-space name) — DECISION NEEDED

**Evidence.** The repo root contains a directory literally named `. agents` (dot, space,
"agents") holding one file: `skills/caveman.md`, a token-compression persona skill. The name
pattern strongly suggests an accidental paste (`.agents` intended). It is unreferenced by
AGENTS.md/CLAUDE.md.

**Owner decision.** (a) delete it; (b) keep the skill but move it to a properly named directory
(e.g. `.agents/skills/`) and reference it from AGENTS.md; the space-named directory should not
survive either way.

**Resolution (2026-07-09).** Owner chose (b), with the constraint that the skill stays
**agent-neutral — available to all agents, not just Claude**. It never triggered because
`. agents/skills/` (with the space; created via the GitHub web editor, `80b26ae`) is not a
location anything reads. Moved to `.agents/skills/caveman.md` and referenced from **AGENTS.md**
(new "Skills (all agents)" section) — AGENTS.md is this repo's single agent-neutral entry point,
so every agent that follows the session protocol now knows to load it on request. Optional
later: thin per-agent discovery shims (e.g. `.claude/skills/caveman/SKILL.md` pointing at the
canonical file) if name-invocation (`/caveman`) is wanted; only on owner request.

**Acceptance.** ✅ No path with a leading `. ` remains; canonical skill lives at
`.agents/skills/caveman.md`; AGENTS.md references it; decision recorded here.

---

## G — Web framework decision: `migration/nextjs-15` branch — DECISION NEEDED

**Evidence.** `main` ships `apps/web` as Vite + React 18 (built under workplan 0005 Phase 4).
Unmerged branch `migration/nextjs-15` rebuilds it on **Next.js 15.0.0-rc.0 + React 19.0.0-rc.1**
(release candidates) and adds `docs/workplans/0006-status-report.md` — which also **collides with
this workplan's number**.

**Considerations.** RC dependencies conflict with the "low-maintenance" principle; on the other
hand the branch adds i18n (EN/NL, ADR-0013), auth and WCAG groundwork the Vite app lacks. Two web
stacks in flight will bit-rot whichever loses.

**Owner decision.** (a) adopt the branch: rebase, move every RC dependency to stable releases,
renumber its doc (suggest `0012-web-nextjs15.md`), then merge and delete the Vite variant; or
(b) stay on Vite: cherry-pick i18n/a11y ideas as tasks into workplan 0011 and close the branch.
Workplan 0011's UI tasks are written to work with either outcome but **block on this decision**.

**Recommendation (2026-07-09 assessment): (b) — stay on Vite; the branch is not needed.**
Rationale: the branch pins **release candidates** (`next@15.0.0-rc.0`, `react@19.0.0-rc.1`) that
are stale prereleases by now, so "finalize" means re-doing the upgrade work anyway; Next.js adds
a server runtime the self-host bundle explicitly doesn't want (arch §7.1 "dependency-light";
the control-plane UI is a status/wizard SPA — nothing needs SSR); the branch predates the Mollie/
lockfile/lint fixes on `main`, so a merge fights conflicts across `apps/web` and the lockfile;
and everything genuinely valuable in it (EN/NL i18n per ADR-0013, auth flow, WCAG 2.2 AA) is
captured as **workplan 0011 T6** requirements achievable in the Vite app. The branch head
(`9722f95`) is preserved as tag **`archive/nextjs-15`** so deleting the branch loses nothing
(`git push origin --delete migration/nextjs-15` when the owner confirms). Record the framework
choice as a short ADR when 0011 T6 starts.

**Acceptance.** Decision recorded here + in an ADR (UI framework choice); losing variant removed;
one web app builds green.

---

## H — Compose duplication & Postgres drift

**Evidence.** Root `docker-compose.yml` (added with 0005) runs `postgres:15-alpine` and a
Trigger.dev stack; `deploy/compose/dev.yml` is the canonical dev stack (CHANGELOG records
PostgreSQL 18 there; AGENTS.md and e2e.yml reference only `deploy/compose/dev.yml`). Two compose
entry points with different Postgres majors will diverge silently. The root file also mounts
`packages/ledger/migrations` as initdb scripts — a second, unmanaged migration path alongside the
Drizzle flow (§22.1).

**Fix (proposed).** Move the managed/Trigger stack to `deploy/compose/managed.yml`, align the
Postgres major with the dev stack, drop the initdb mount in favor of the migration runner, and
keep the repo root compose-free (docs updated).

**Acceptance.** One compose directory; both stacks boot; documented in `docs/deployment.md`.

---

## I — Re-enable `no-unused-vars`

**Evidence.** Commit `04fcf33` ("fix: disable no-unused-vars lint rule and clean up test")
switched the rule off repo-wide in `eslint.config.js` to get CI green — a masking fix.

**Fix (proposed).** Re-enable as `@typescript-eslint/no-unused-vars` with
`argsIgnorePattern: '^_'`, `varsIgnorePattern: '^_'`; fix the fallout (expect it concentrated in
the 0005-era API/web code).

**Acceptance.** Rule active; `pnpm lint` green without blanket disables (file-local
`eslint-disable-next-line` with a reason is acceptable where genuinely needed).

---

## J — Worker CLI config-path bug

**Evidence.** `apps/worker/src/index.ts` `loadConfig()` does `join(__dirname, configPath)` — the
config is resolved relative to the **compiled module's directory**, not the invoker's cwd, and an
absolute `--config C:\...\mapping.json` gets mangled. The README's documented invocation
(`--config ./mapping.example.json` from the repo root) therefore cannot work.

**Fix (proposed).** `resolve(process.cwd(), configPath)`; add a unit test
(`index.unit.test.ts` already exists as a home for it); verify the README quickstart command runs
against the dev stack.

**Acceptance.** `--config` works with relative-to-cwd and absolute paths; quickstart verified.

---

## Suggested execution order
A (unblocks trust in every other plan) → C → J → D → I → B → H → E; F and G are pure owner
decisions and can land any time. Items are independent; one small PR per item, gates green each
time (AGENTS.md session protocol applies — update this Status block with evidence per item).

## Out of scope (tracked in feature workplans)
- Runtime RLS enforcement (`SET app.current_tenant` is set nowhere in app code) → **0011 T1**,
  because the fix belongs with the managed-edition API work.
- Replacing the `unified-sync` stub → **0007**; Trigger job payload-cast cleanup → **0011**.
