# 1. OBJECTIVE

Execute workplan 0006 — Intermediate remediation: address 8 verified repo integrity findings that undermine trust in the test suite, documentation accuracy, and CI security. This workplan was approved by the owner on 2026-07-09 and must be completed before proceeding with feature workplans 0007+.

# 2. CONTEXT SUMMARY

**Repository:** open-migrate (sovereign mail/migration sync system)  
**Current state:** `main` @ `f1acd4a`  
**Critical issue:** Core idempotency property tests (`packages/core/src/reconcile.test.ts`) and 16 other test files match no vitest project include pattern, meaning they have never run in CI or locally. This violates AGENTS.md hard rule #1 (idempotency is sacred) and #9 (never mask errors).

**Findings summary:**
- **A** — Test-selection gap: 17 test files silently skipped by vitest
- **B** — Docs case collision: `DEPLOYMENT.md` vs `deployment.md` breaks Windows clones
- **C** — Docs integrity: Workplan status blocks misrepresent code state; broken links; stale README
- **D** — Root dependency cleanup: stale `mollie-api-node`, misplaced `imap-simple`
- **E** — CI hardening: self-hosted runner exposed to fork PRs; unpinned actions
- **G** — Compose duplication: two docker-compose files with different Postgres versions
- **H** — Lint regression: `no-unused-vars` disabled repo-wide to mask issues
- **I** — Worker CLI bug: `--config` path resolution broken for absolute/relative paths

**Dependencies:** None — this workplan is foundational and gates all subsequent workplans.

# 3. APPROACH OVERVIEW

Work on a dedicated branch (`remediation/0006-intermediate`) with the following principles:

1. **Sequential execution** — Items should be addressed in order A→I, as some depend on others (e.g., H requires A to be fixed first to see real lint errors)
2. **Evidence-first** — Quote errors verbatim before fixing; verify each item's acceptance criteria before marking complete
3. **Task tracking** — Maintain a checklist in the agent session; spawn subagents for parallel work where safe (items B, D, G can run in parallel after A)
4. **No masking** — Remove `--passWithNoTests` only after fixing the underlying test issues
5. **Documentation updates** — Update `docs/testing.md`, `README.md`, and workplan status blocks as part of the fix

**Parallelization opportunities:**
- After item A completes: B, D, G can proceed in parallel
- Item H can start once A is done (to see actual unused vars)
- Items C, E, I are independent and can run anytime

# 4. IMPLEMENTATION STEPS

## Step A: Fix test-selection gap (CRITICAL — 17 files never running)

**Goal:** Ensure all test files execute under the correct vitest project (unit/integration).

**Method:**
1. List all `*.test.ts` and `*.test.tsx` files that don't match the include patterns
2. Rename files to correct suffix:
   - Pure logic tests → `*.unit.test.ts`
   - DB-backed tests (`rls.test.ts`) → `*.integration.test.ts`
3. Update `vitest.config.ts` project includes if needed (prefer renaming over widening globs)
4. Remove `--passWithNoTests` from `pnpm test` and `pnpm test:integration` scripts
5. Run `pnpm test` and `pnpm test:integration`; fix any failures (quote errors verbatim)
6. Add a CI guard: test that fails if any `*.test.ts?(x)` matches no project include

**Files impacted:**
- `packages/core/src/reconcile.test.ts` → `reconcile.unit.test.ts`
- `packages/core/src/reindex.test.ts` → `reindex.unit.test.ts`
- `packages/core/src/unified-sync.idempotency.test.ts` → `unified-sync.idempotency.unit.test.ts`
- `packages/shared/src/hash.test.ts`, `config.test.ts`, `cursor.test.ts`, `keywords.test.ts`, `specialUse.test.ts`, `concurrency.test.ts`, `index.test.ts`
- `packages/ledger/src/ledger.test.ts`, `index.test.ts`, `rls.test.ts` (→ integration)
- `packages/connectors/src/imap-source.test.ts`
- `packages/scheduler/src/single-flight.test.ts`
- `apps/api/src/__tests__/billing-service.test.ts`
- `apps/web/src/__tests__/Dashboard.test.tsx`

**Acceptance:** All 17 files execute in `pnpm test`/`pnpm test:integration`; no test files silently skipped.

---

## Step B: Resolve docs case collision

**Goal:** Eliminate `DEPLOYMENT.md` vs `deployment.md` collision that breaks Windows clones.

**Method:**
1. Compare contents of both files (`diff docs/DEPLOYMENT.md docs/deployment.md`)
2. Merge any valuable content from uppercase to lowercase (canonical per its header)
3. Remove uppercase from git: `git rm --cached "docs/DEPLOYMENT.md"`
4. Commit the resolution
5. Add CI hygiene check: script that fails when two tracked paths differ only by case

**Files impacted:**
- `docs/DEPLOYMENT.md` (remove from tracking)
- `docs/deployment.md` (canonical, may receive merged content)
- CI workflow (add case-collision check)

**Acceptance:** Fresh Windows clone shows no collision warning; CI rejects future case collisions.

---

## Step C: Fix docs integrity issues

**Goal:** Correct misleading status blocks, broken links, and stale examples.

**Method:**
1. **0003 correction:** Update status to reflect that `unified-sync.ts` is a stub returning zeros; no cal/contact/file sources; ledger lacks item-type; superseded by 0007
2. **0004 correction:** Update status to show Phases 1-3 unit-level done, Phase 4 open; superseded by 0009
3. **Restore 0005:** Extract from git history (`git show f1acd4a^:.agents_tmp/PLAN.md`) as `docs/workplans/0005-managed-edition.md`; fix broken links to ADRs
4. **README refresh:** Update worker dependency wiring note; fix mapping config JSON example to match actual schema in `packages/shared/src/config.ts`

**Files impacted:**
- `docs/workplans/0003-caldav-carddav-webdav.md`
- `docs/workplans/0004-cutover-dns.md`
- `docs/workplans/0005-managed-edition.md` (restore)
- `README.md`

**Acceptance:** All workplan status blocks match verified code state; no dead links; README example validates against `parseMappingConfig`.

---

## Step D: Clean root dependencies

**Goal:** Remove stale/unneeded dependencies from root `package.json`; move to correct packages.

**Method:**
1. Verify no imports of `mollie-api-node`: `grep -r "from 'mollie-api-node'"`
2. Remove `mollie-api-node` from root `package.json`
3. Remove `apps/api/src/types/mollie-api-node.d.ts`
4. Move `imap-simple` and `@types/imap-simple` from root to `packages/connectors/package.json`
5. Regenerate lockfile: `pnpm install`
6. Verify: `pnpm install --frozen-lockfile`, lint, typecheck, tests all green

**Files impacted:**
- Root `package.json`
- `apps/api/src/types/mollie-api-node.d.ts` (delete)
- `packages/connectors/package.json`

**Acceptance:** Root manifest free of unused deps; all gates green.

---

## Step E: Harden CI security

**Goal:** Prevent untrusted fork PRs from executing on self-hosted runner with docker socket + root access.

**Method:**
1. Modify `.github/workflows/ci.yml`:
   - Set `runs-on: ubuntu-latest` for `lint` and `unit` jobs
   - Keep `integration` and `e2e` on `self-hosted` but add condition:
     ```yaml
     if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository
     ```
2. Pin unpinned actions to commit SHAs:
   - `pnpm/action-setup@v4` → find latest SHA
   - `actions/setup-node@v4` → find latest SHA
3. Update `docs/testing.md` with the runner policy

**Files impacted:**
- `.github/workflows/ci.yml`
- `docs/testing.md`

**Acceptance:** Fork PRs cannot reach self-hosted runner; all actions SHA-pinned; pipeline green.

---

## Step G: Consolidate docker-compose files

**Goal:** Eliminate duplication and Postgres version drift between root `docker-compose.yml` and `deploy/compose/dev.yml`.

**Method:**
1. Analyze root `docker-compose.yml` (Postgres 15, Trigger.dev stack, initdb mount)
2. Analyze `deploy/compose/dev.yml` (Postgres 18, canonical per CHANGELOG)
3. Create `deploy/compose/managed.yml` for the managed/Trigger stack with aligned Postgres version
4. Remove root `docker-compose.yml`
5. Update documentation to reference only `deploy/compose/` files
6. Verify both stacks boot correctly

**Files impacted:**
- Root `docker-compose.yml` (remove)
- `deploy/compose/managed.yml` (create)
- `docs/deployment.md`, `AGENTS.md` (update references)

**Acceptance:** Single compose directory; both dev and managed stacks boot; docs consistent.

---

## Step H: Re-enable `no-unused-vars` lint rule

**Goal:** Restore the disabled lint rule and fix actual violations.

**Method:**
1. Re-enable in `eslint.config.js`:
   ```js
   '@typescript-eslint/no-unused-vars': ['error', {
     argsIgnorePattern: '^_',
     varsIgnorePattern: '^_'
   }]
   ```
2. Run `pnpm lint` to surface violations
3. Fix violations (expect concentration in 0005-era API/web code)
4. Use `eslint-disable-next-line` with reason only where genuinely needed

**Files impacted:**
- `eslint.config.js`
- Various source files with unused variables (likely `apps/api/`, `apps/web/`)

**Acceptance:** Rule active; `pnpm lint` green; no blanket disables.

---

## Step I: Fix worker CLI config-path bug

**Goal:** Correct `--config` path resolution to work with both relative and absolute paths.

**Method:**
1. In `apps/worker/src/index.ts`, change `loadConfig()`:
   - From: `join(__dirname, configPath)`
   - To: `resolve(process.cwd(), configPath)`
2. Add unit test in `apps/worker/src/index.unit.test.ts`:
   - Test relative path resolution from different cwd
   - Test absolute path handling
3. Verify README quickstart command works: `pnpm --workspace apps/worker start --config ./mapping.example.json`

**Files impacted:**
- `apps/worker/src/index.ts`
- `apps/worker/src/index.unit.test.ts`

**Acceptance:** `--config` works with relative and absolute paths; README quickstart verified.

# 5. TESTING AND VALIDATION

**Verification criteria for each item:**

| Item | Validation Method |
|------|-------------------|
| A | Run `pnpm test` and `pnpm test:integration`; confirm all 17 files execute; no `passWithNoTests` masking |
| B | Fresh clone on Windows shows no collision warning; CI check rejects case collisions |
| C | Spot-check 0003, 0004, 0005 status blocks against code; validate README example with `parseMappingConfig` |
| D | `pnpm install --frozen-lockfile` green; `grep` confirms no `mollie-api-node` imports |
| E | Fork PR triggers show lint/unit on `ubuntu-latest`; integration/e2e gated; all actions SHA-pinned |
| G | Both stacks in `deploy/compose/` boot; root has no compose file; docs reference correct paths |
| H | `pnpm lint` green with rule enabled; no unused vars except those prefixed with `_` |
| I | Worker `--config` works from repo root with relative path; unit tests pass |

**Overall success criteria:**
- All 8 items complete with evidence in status block
- CI pipeline green end-to-end on the remediation branch
- No new regressions introduced
- Documentation accurately reflects code state
- Ready for owner merge to `main`

**Next steps after completion:**
- Update workplan 0006 status block with evidence links
- Notify owner for review and merge
- Proceed to workplans 0007 and 0011-T1 in parallel