# Part A — Ground-Truth Report: Workplan 0011 Status

**Date:** 2026-07-17  
**Purpose:** Establish ground truth before proposing next workplan 0011 task. Part A is report-only; Part B will be a design proposal.

---

## a. docs/workplans/0011-managed-edition-hardening.md — Full Status Block

```markdown
# Workplan 0011 — Managed edition hardening: RLS for real, API completion, billing e2e

## Status — 2026-07-16 (update this block at the end of every session)

> **This is the big remaining epic.** Some DB-layer RLS groundwork landed as a side effect of the
> cutover work (0009); the security-critical *application-layer* enforcement and everything above
> it are still open. `deploy/compose/managed.yml` already exists (from 0006-G). Ordering unchanged:
> **T1 first** — no other task touches tenant data until the fail-closed tenant context exists.

| Task | Status | Evidence |
|---|---|---|
| T1 runtime RLS enforcement (CRITICAL) | ✅ Done | **DB layer:** `packages/ledger/migrations/0008_force_rls_enforcement.sql` (FORCE RLS) + `0009_create_app_user_role.sql` (non-owner `app_user` role, password `app_password`). **App layer:** `packages/ledger/src/rls.integration.test.ts` proves 6 properties: (1) tenant A rows invisible to tenant B, (2) cross-tenant INSERT fails, (3) fail-closed when no context set (errors instead of returning all rows), (4) cross-tenant UPDATE prevented, (5) cross-tenant DELETE prevented, (6) rollback on error. **Helper:** `withTenant(pool, tenantId, fn)` in `packages/ledger/src/db.ts` uses `SELECT set_config('app.current_tenant', $1, true)` for transaction-scoped context. **API wiring:** `apps/api/src/middleware/auth.ts` exposes `withTenantDb()` wrapper; `apps/api/src/routes/tenants/index.ts` uses it for GET /api/tenants and GET /api/tenants/:id. **API test:** `apps/api/src/routes/tenants/tenants.integration.test.ts` proves HTTP-layer tenant isolation — tenant B's token cannot read tenant A's data. **Gates:** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` all pass (80 integration tests, 397 unit tests). |
| T2 API routes: real persistence | ⬜ Pending | All handlers still `// TODO: Query database` — verified in `apps/api/src/routes/tenants/index.ts`, `routes/migrations/index.ts`, `routes/billing/*` |
| T3 Trigger.dev wiring: jobs call the real core | ⬜ Pending | `apps/worker/src/jobs/*.ts` validate payloads + log; don't call `runShadowPass`/domain sync/cutover core |
| T4 usage metering from real runs | ⬜ Pending | `usage_metric` table exists; nothing emits to it |
| T5 billing + Mollie test-mode end-to-end | ⬜ Pending | `@mollie/api-client@4` service exists; invoice/webhook flow not wired |
| T6 web UI wired to the real API | ⬜ Pending | Vite React app calls `/api` (still TODO shells). Note: `migration/nextjs-15` branch was **not** adopted — Vite stays (tag `archive/nextjs-15` preserves the RC work) |
| T7 managed compose stack + operator docs | 🟡 Partial | `deploy/compose/managed.yml` exists (0006-G); needs seed script + `docs/operator-runbook.md` + verification the stack runs the DoD journey |
```

**Summary:** T1 is done (RLS enforcement + API wiring for GET /api/tenants and GET /api/tenants/:id). T2–T6 are pending. T7 is partial (compose exists, seed/runbook missing).

---

## b. apps/api — Route Enumeration and withTenantDb Coverage

### Route Inventory

| Method | Path | Auth Required | withTenantDb Used | Notes |
|--------|------|---------------|-------------------|-------|
| GET | `/api/tenants` | ✅ `authenticate` | ✅ Yes (lines 74–76) | Uses `withTenantDb` to list tenants |
| POST | `/api/tenants` | ✅ `authenticate` | ❌ No | TODO shell — returns mock data |
| GET | `/api/tenants/:tenantId` | ✅ `authenticate` | ✅ Yes (lines 161–163) | Uses `withTenantDb` to fetch tenant |
| PUT | `/api/tenants/:tenantId` | ✅ `authenticate` + `requireRole` | ❌ No | TODO shell — no DB access |
| DELETE | `/api/tenants/:tenantId` | ✅ `authenticate` + `requireRole('owner')` | ❌ No | TODO shell — no DB access |
| GET | `/api/mappings` | ✅ `authenticate` | ❌ No | TODO shell — returns mock data |
| POST | `/api/mappings` | ✅ `authenticate` | ❌ No | TODO shell — returns mock data |
| GET | `/api/mappings/:mappingId` | ✅ `authenticate` | ❌ No | TODO shell — returns mock data |
| PUT | `/api/mappings/:mappingId` | ✅ `authenticate` | ❌ No | TODO shell — no DB access |
| DELETE | `/api/mappings/:mappingId` | ✅ `authenticate` | ❌ No | TODO shell — no DB access |
| POST | `/api/mappings/:mappingId/sync` | ✅ `authenticate` | ❌ No | TODO shell — doesn't trigger real job |
| POST | `/api/mappings/:mappingId/cutover` | ✅ `authenticate` + `requireRole` | ❌ No | TODO shell — doesn't trigger real job |
| GET | `/api/mappings/:mappingId/runs` | ✅ `authenticate` | ❌ No | TODO shell — returns mock data |
| GET | `/api/mappings/:mappingId/runs/:runId` | ✅ `authenticate` | ❌ No | TODO shell — returns mock data |
| GET | `/api/billing/usage` | ✅ `authenticate` | ❌ No | Uses in-memory `billingApi` — no DB |
| POST | `/api/billing/usage` | ✅ `authenticate` | ❌ No | Uses in-memory `billingApi` — no DB |
| GET | `/api/billing/usage/history` | ✅ `authenticate` | ❌ No | Uses in-memory `billingApi` — no DB |
| POST | `/api/billing/estimate` | ✅ `authenticate` | ❌ No | Uses in-memory `billingApi` — no DB |
| GET | `/api/billing/invoices` | ✅ `authenticate` | ❌ No | Uses in-memory `billingApi` — no DB |
| GET | `/api/billing/invoices/:invoiceId` | ✅ `authenticate` | ❌ No | Uses in-memory `billingApi` — no DB |
| POST | `/api/billing/invoices/:invoiceId/pay` | ✅ `authenticate` | ❌ No | Calls Mollie but uses in-memory billingApi |
| GET | `/api/billing/payment-methods` | ✅ `authenticate` | ❌ No | Uses in-memory `billingApi` — no DB |
| POST | `/api/billing/payment-methods` | ✅ `authenticate` | ❌ No | Uses in-memory `billingApi` — no DB |
| PATCH | `/api/billing/payment-methods/:paymentMethodId/default` | ✅ `authenticate` | ❌ No | Uses in-memory `billingApi` — no DB |
| POST | `/api/billing/webhooks/mollie` | ❌ No auth | ❌ No | Webhook endpoint — TODO for invoice update |
| GET | `/api/billing/webhooks/mollie/test` | ❌ No auth | ❌ No | Dev-only health check |
| POST | `/api/webhooks/trigger` | ❌ Signature optional | ❌ No | Trigger.dev webhook — TODO for run update |
| GET | `/api/webhooks/trigger` | ❌ No auth | ❌ No | Health check |
| GET | `/api/tenants/:tenantId/members` | ✅ `authenticate` | ❌ No | TODO shell — returns mock data |
| POST | `/api/tenants/:tenantId/members` | ✅ `authenticate` + `requireRole` | ❌ No | TODO shell — returns mock data |
| GET | `/api/tenants/:tenantId/members/:memberId` | ✅ `authenticate` | ❌ No | TODO shell — returns mock data |
| PATCH | `/api/tenants/:tenantId/members/:memberId` | ✅ `authenticate` + `requireRole` | ❌ No | TODO shell — no DB access |
| DELETE | `/api/tenants/:tenantId/members/:memberId` | ✅ `authenticate` + `requireRole` | ❌ No | TODO shell — no DB access |

### Security Findings

**CRITICAL:** Routes that return tenant data WITHOUT `withTenantDb`:
- **All billing routes** (`/api/billing/*`) — use in-memory `billingApi` service, not the ledger. This is a **data isolation gap** — billing data is not RLS-scoped.
- **All mappings routes** (`/api/mappings/*`) — return mock data, no DB access yet.
- **All members routes** (`/api/tenants/:tenantId/members/*`) — return mock data, no DB access yet.
- **Tenant CRUD (POST/PUT/DELETE)** — TODO shells, no DB access yet.

**Current protection:** The GET routes for tenants (`/api/tenants` and `/api/tenants/:id`) ARE protected with `withTenantDb`. All other routes either return mock data or use in-memory services that bypass RLS entirely.

---

## c. apps/web and apps/selfhost — Implementation Status

### apps/web (Vite React SPA)

**What it is:** A Vite-based React single-page application that provides the user interface for the managed edition. It uses React Router for navigation, TanStack Query for data fetching, and axios for HTTP communication with the API.

**Implemented:**
- UI components: `Layout.tsx`, `Dashboard.tsx`, `Mappings.tsx`, `MappingDetail.tsx`, `Billing.tsx`, `OperatorDashboard.tsx`, `CreateMapping.tsx`, `Login.tsx`, `Tenants.tsx`, `Settings.tsx`
- State management: `auth-store.ts` (authentication state), `mapping-store.ts` (mapping configuration state)
- API client: `api.ts` (axios instance with JWT injection and 401 handling), `mapping-service.ts`, `billing-service.ts`
- Routing: `App.tsx` defines routes for all pages

**Stubbed/Not wired:**
- The UI calls real API endpoints, but those endpoints return mock/TODO data
- No actual login flow — the login page exists but doesn't integrate with a real auth provider
- Billing page exists but displays no real invoice data
- Mapping wizard UI exists but submissions hit TODO API handlers

**Status:** Frontend scaffolding complete; all pages render but connect to unimplemented backend endpoints.

### apps/selfhost

**What it is:** A stub package for the self-hosted edition. Currently contains only a single export file.

**Implemented:**
- `src/index.ts` exports `app = '@openmig/selfhost'` — essentially a placeholder

**Stubbed/Not implemented:**
- No actual self-host application code exists
- No UI, no API, no worker — just the package structure

**Status:** Self-host is not yet implemented; the package exists as a placeholder for future development. Per hard rule 5, self-host must keep working independently of managed-mode code.

---

## d. API Relation to Migration Engine

**Can the API trigger/monitor a migration?**

**Current state:** NO — the API has the route surface but no real integration.

**Evidence:**
- `POST /api/mappings/:mappingId/sync` (lines 267–308 in `routes/migrations/index.ts`):
  - Validates payload with `TriggerSyncSchema`
  - Has TODO comments showing intended Trigger.dev integration
  - Returns mock `{ success: true, runId: 'run-${Date.now()}' }`
  - Does NOT call the Trigger.dev client or any real job

- `POST /api/mappings/:mappingId/cutover` (lines 315–357):
  - Validates payload with `TriggerCutoverSchema`
  - Returns mock cutover response
  - Does NOT trigger the cutover job

- `GET /api/mappings/:mappingId/runs` and `GET /api/mappings/:mappingId/runs/:runId`:
  - Return hardcoded mock run data
  - Do NOT query the `run` or `run_event` tables

- Worker jobs (`apps/worker/src/jobs/run-delta-sync.ts`, etc.):
  - Jobs exist and validate payloads
  - `run-delta-sync.ts` has scaffolding to call `runShadowPass` but uses `null as unknown as SourceConnector` and `null as unknown as TargetWriter`
  - Jobs log progress but don't have real connector implementations wired in

**Migration status read:** The API has no endpoint to read `migration_status` from the ledger. The `PgMigrationStatusStore` exists in `@openmig/ledger` but is not exposed via the API.

**Summary:** The API is a shell — it has the route structure and validation but no real persistence or job orchestration. The migration engine (worker + core) exists but is not connected to the API.

---

## e. Auth Completeness — Managed vs Self-Hosted Path

**Current auth.ts implementation (lines 63–139):**

```typescript
if (jwtSecret) {
  // Self-hosted: Verify with local secret
  payload = jwt.verify(token, jwtSecret) as JwtPayload;
} else if (jwtIssuer) {
  // Managed: Verify with issuer (e.g., Auth0, Clerk)
  // For now, we'll decode without verification
  const decoded = jwt.decode(token);
  if (!decoded) {
    throw new Error('Invalid token');
  }
  payload = decoded as JwtPayload;
} else {
  // Development mode: Accept any valid-looking JWT
  console.warn('JWT verification disabled - development mode');
  const decoded = jwt.decode(token);
  ...
}
```

**Assessment:**

| Path | Status | Details |
|------|--------|---------|
| **Self-hosted (local JWT)** | ✅ Implemented | Uses `jwt.verify(token, jwtSecret)` with HS256 |
| **Managed (Auth0/Clerk)** | ⚠️ TODO / Incomplete | Only decodes token WITHOUT verification — `jwt.decode()` skips signature validation. Comment says "In production, use jose or similar library for public key verification" |
| **Development mode** | ✅ Implemented | Accepts any token (warning logged) |

**Critical Gap:** The managed path is a **security hole** — it accepts ANY token from ANY issuer as long as it decodes to valid JSON. There is:
- No issuer validation (not checking `iss` claim against configured `JWT_ISSUER`)
- No audience validation (not checking `aud` claim)
- No signature verification (using `jwt.decode()` instead of `jwt.verify()` with JWKS)
- No algorithm validation

**This is a TODO placeholder, not an implementation.** In production mode with `JWT_ISSUER` set but no `JWT_SECRET`, the app would accept forged tokens.

---

## f. API Test Coverage

### Existing Tests

| Route | Test File | Coverage |
|-------|-----------|----------|
| GET /api/tenants | `apps/api/src/routes/tenants/tenants.integration.test.ts` | ✅ 3 tests: list tenants, cross-tenant access blocked, own access allowed |
| GET /api/tenants/:id | Same as above | ✅ Same test file |
| POST /api/tenants | ❌ | No tests — route is a TODO shell |
| PUT /api/tenants/:id | ❌ | No tests |
| DELETE /api/tenants/:id | ❌ | No tests |
| All /api/mappings/* | ❌ | No tests — all routes are TODO shells |
| All /api/billing/* | ❌ | No tests — routes use in-memory services |
| POST /api/billing/webhooks/mollie | ❌ | No tests |
| POST /api/webhooks/trigger | ❌ | No tests |

### Test Infrastructure

- **Integration tests:** Use Testcontainers for PostgreSQL
- **Test command:** `pnpm test:integration`
- **Tenant isolation test:** `apps/api/src/routes/tenants/tenants.integration.test.ts` proves cross-tenant access is blocked at HTTP layer
- **Gap:** Only the tenant GET routes have integration tests. All other routes (mappings, billing, members, webhooks) are untested.

---

## Summary of Findings

### Completed (T1)
- RLS enforcement at DB layer (migrations 0008, 0009)
- `withTenant` helper in `packages/ledger`
- `withTenantDb` wrapper in auth middleware
- GET /api/tenants and GET /api/tenants/:id wired with `withTenantDb`
- Cross-tenant isolation test passing

### Critical Gaps
1. **Managed auth path is a TODO** — accepts unverified tokens (security risk)
2. **All other API routes are TODO shells** — no real persistence
3. **Billing routes bypass RLS** — use in-memory service
4. **No integration tests** for mappings, billing, members, webhooks
5. **Worker jobs don't call real core** — use null connectors

### Next Logical Task
Per workplan 0011 ordering, **T2 (API routes: real persistence)** is the next incomplete task. However, the **managed auth path gap** is a security-critical issue that should be addressed before or alongside T2, as it undermines tenant isolation at the authentication layer.

---

*End of Part A — Ground Truth Report*
