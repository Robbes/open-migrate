# Workplan 0005: Managed Edition — Multi-tenant Orchestration & Billing

## 1. OBJECTIVE

Implement the **managed edition** control plane for the Open Migration Stack, enabling a multi-tenant SaaS offering with Trigger.dev orchestration, Postgres RLS-based tenant isolation, and cost-recovery billing. This workplan delivers the infrastructure and API layer that allows families and SMBs to use the migration service without self-hosting, while maintaining the same idempotent migration core as the self-host edition.

## 2. CONTEXT SUMMARY

**Current State:**
- Workplan 0001 (JMAP mail slice): ✅ COMPLETE
- Workplan 0002 (IMAP/DAV targets): ✅ COMPLETE  
- Workplan 0003 (Calendar/Contacts/Files): IN PROGRESS
- Workplan 0004 (Cutover & DNS): IN PROGRESS

**Architecture Foundation:**
- **ADR-0003**: Two editions (self-host + managed) from one core codebase
- **ADR-0004**: Orchestration via Trigger.dev (managed) + in-process scheduler (self-host)
- **ADR-0010**: Postgres with RLS for managed, SQLite for self-host
- **ADR-0014**: Cost-recovery billing (no profit) for managed edition
- **Solution Architecture §7**: Two delivery models with identical migration cores

**Key Components to Build:**
1. Multi-tenant database schema with RLS policies
2. Trigger.dev integration for durable job orchestration
3. REST API for tenant management, migration control, and billing
4. Web UI for tenant-facing migration dashboard
5. Billing engine with Mollie payment processing
6. Operator tooling and documentation

**Constraints:**
- Migration core must remain edition-agnostic (no managed-only dependencies in `packages/`)
- Self-host edition must continue working without Trigger.dev or Postgres RLS
- All data must be tenant-isolated via RLS in managed mode
- Billing must be cost-recovery only (no profit margin)

## 3. APPROACH OVERVIEW

This workplan follows a phased approach, building the managed edition control plane while preserving the existing migration core:

**Phase 1: Database Foundation** — Extend ledger schema with tenant support and RLS
**Phase 2: Orchestration** — Integrate Trigger.dev for durable job execution
**Phase 3: API Layer** — Build REST API for all managed edition operations
**Phase 4: Web UI** — Create tenant-facing dashboard
**Phase 5: Billing** — Implement cost-recovery metering and payment processing
**Phase 6: Operations** — Deploy tooling and documentation

**Why This Approach:**
- Builds on existing migration core (0001-0004) without duplication
- Follows the "two editions, one core" principle from ADR-0003
- Uses proven technologies (Trigger.dev, Postgres RLS, Mollie)
- Enables gradual rollout: infrastructure first, then UI, then billing
- Maintains backward compatibility with self-host edition

## 4. IMPLEMENTATION STEPS

### Phase 1: Multi-tenant Database Schema & RLS

**T1.1 — Schema extensions for multi-tenancy**
- **Goal:** Add tenant support to all tables
- **Method:** Create migrations for `tenants`, `tenant_members`, `mappings`, `migration_runs` tables; add `tenant_id` to existing ledger tables
- **Reference:** `packages/ledger/migrations/`, ADR-0010

**T1.2 — Row-Level Security (RLS) policies**
- **Goal:** Enforce tenant isolation at database level
- **Method:** Enable RLS on all tenant-scoped tables; create policies for SELECT/INSERT/UPDATE/DELETE with `tenant_id = current_setting('app.current_tenant')`
- **Reference:** Postgres RLS docs, `packages/ledger/schema.ts`

**T1.3 — Ledger schema v2 migration**
- **Goal:** Migrate existing data to multi-tenant schema
- **Method:** Create idempotent migration script; add `tenant_id` and `mapping_id` to ledger; ensure backward compatibility
- **Reference:** `packages/ledger/migrations/`, ADR-0016

**Acceptance Criteria:**
- Schema migrations apply cleanly to Postgres
- RLS policies prevent cross-tenant data access (verified by integration tests)
- Self-host edition continues working with SQLite (no RLS)

---

### Phase 2: Trigger.dev Integration

**T2.1 — Trigger.dev setup & configuration**
- **Goal:** Get Trigger.dev running (self-hosted or Cloud)
- **Method:** Set up Trigger.dev via Docker Compose or create account on Trigger.dev Cloud; configure environment variables
- **Reference:** Trigger.dev docs, `apps/trigger/`

**T2.2 — Scheduler interface implementation**
- **Goal:** Implement `TriggerScheduler` class
- **Method:** Create `packages/scheduler/src/trigger-scheduler.ts` implementing `Scheduler` interface; map Trigger.dev jobs to `schedule()` calls
- **Reference:** `packages/scheduler/src/scheduler.ts`, ADR-0004

**T2.3 — Migration job definitions**
- **Goal:** Create Trigger.dev jobs for migration operations
- **Method:** Define jobs: `run-full-sync`, `run-delta-sync`, `run-cutover`, `run-rollback`; each accepts `tenantId` + `mappingId`; use existing migration core
- **Reference:** `packages/core/src/`, Trigger.dev job structure

**T2.4 — Job monitoring & webhooks**
- **Goal:** Track job status and history
- **Method:** Implement webhook handlers for job events; store status in `migration_runs` table; create API endpoints for querying
- **Reference:** Trigger.dev webhooks, `apps/api/`

**Acceptance Criteria:**
- Trigger.dev jobs execute end-to-end
- Retries work with exponential backoff
- Idempotency preserved (re-running jobs doesn't create duplicates)
- Job history is queryable via API

---

### Phase 3: API Layer

**T3.1 — API architecture & authentication**
- **Goal:** Set up Express.js API with JWT auth
- **Method:** Create `apps/api/` with Express; implement JWT middleware; inject `tenantId` from token into request context
- **Reference:** `apps/api/src/`, JWT best practices

**T3.2 — Tenant management API**
- **Goal:** CRUD operations for tenants and members
- **Method:** Implement endpoints: `POST/GET/PUT/DELETE /api/tenants`, member management endpoints; enforce roles
- **Reference:** `apps/api/src/routes/tenants.ts`

**T3.3 — Migration management API**
- **Goal:** Control migrations via API
- **Method:** Implement endpoints for mappings, sync triggers, run history; integrate with Trigger.dev jobs
- **Reference:** `apps/api/src/routes/mappings.ts`, `apps/api/src/routes/runs.ts`

**T3.4 — Billing API**
- **Goal:** Expose usage and billing data
- **Method:** Implement endpoints for usage metrics, billing history, payment methods; integrate with Mollie
- **Reference:** `apps/api/src/routes/billing.ts`, Mollie API docs

**T3.5 — API documentation**
- **Goal:** Comprehensive API docs
- **Method:** Generate OpenAPI/Swagger spec; set up Swagger UI or Redoc; add examples
- **Reference:** Swagger/OpenAPI spec

**Acceptance Criteria:**
- All endpoints work with proper authentication
- RLS enforces tenant isolation
- API docs are accurate and interactive
- Integration tests cover all endpoints

---

### Phase 4: Web UI

**T4.1 — UI architecture & setup**
- **Goal:** React app with authentication and i18n
- **Method:** Set up `apps/web/` with React; configure React Query + Zustand; implement JWT auth flow; add i18n (EN + NL)
- **Reference:** `apps/web/`, ADR-0013

**T4.2 — Tenant dashboard**
- **Goal:** Overview of tenant's migrations and activity
- **Method:** Create dashboard page showing active mappings, recent runs, usage stats
- **Reference:** `apps/web/src/pages/Dashboard.tsx`

**T4.3 — Migration configuration wizard**
- **Goal:** Step-by-step mapping setup
- **Method:** Build wizard with steps: source → target → credentials → data types → schedule → review; validate at each step
- **Reference:** `apps/web/src/components/MigrationWizard/`

**T4.4 — Migration monitoring**
- **Goal:** Real-time progress and logs
- **Method:** Display active migration progress; show logs; display errors with suggestions; implement cutover wizard
- **Reference:** `apps/web/src/components/MigrationMonitor/`

**T4.5 — UI testing**
- **Goal:** Ensure UI reliability
- **Method:** Write unit tests for components; integration tests for flows; E2E tests for critical paths (using Playwright or Cypress)
- **Reference:** `apps/web/__tests__/`

**Acceptance Criteria:**
- UI builds and runs successfully
- Users can authenticate and navigate
- All wizard steps work end-to-end
- Real-time updates work (WebSockets or polling)
- Bilingual (EN/NL) throughout

---

### Phase 5: Billing & Cost Recovery

**T5.1 — Metering implementation**
- **Goal:** Track resource usage per tenant
- **Method:** Create `usage_metrics` table; track storage, egress, compute; aggregate daily/monthly via scheduled jobs
- **Reference:** `packages/ledger/schema.ts`, Trigger.dev jobs

**T5.2 — Billing engine**
- **Goal:** Calculate invoices based on usage
- **Method:** Implement pricing model: base fee + storage overage + egress charges; calculate monthly; support prorating
- **Reference:** ADR-0014, `apps/api/src/billing/engine.ts`

**T5.3 — Payment processing (Mollie)**
- **Goal:** Collect payments
- **Method:** Integrate Mollie API; implement payment method attachment, invoice generation, payment collection, failure handling
- **Reference:** Mollie docs, `apps/api/src/billing/mollie.ts`

**T5.4 — Billing UI**
- **Goal:** Display usage and manage payments
- **Method:** Show current usage/costs; display billing history; allow payment method management; provide cost estimates
- **Reference:** `apps/web/src/pages/Billing.tsx`

**Acceptance Criteria:**
- Usage metrics are collected accurately
- Invoice calculations are correct (verified by tests)
- Payments process successfully via Mollie
- Failed payments are handled gracefully
- Billing UI is functional and accurate

---

### Phase 6: Operator Tooling & Documentation

**T6.1 — Operator dashboard**
- **Goal:** Admin interface for service management
- **Method:** Create admin UI for tenant management, system health, usage analytics, billing oversight, support tools
- **Reference:** `apps/web/src/pages/Admin/`

**T6.2 — Deployment & operations**
- **Goal:** Production-ready deployment
- **Method:** Docker Compose for local dev; Helm charts for Kubernetes; environment configs (dev/staging/prod); monitoring/alerting setup
- **Reference:** `deploy/compose/`, `deploy/helm/`

**T6.3 — Documentation**
- **Goal:** Comprehensive operational docs
- **Method:** Write operator runbook, tenant onboarding guide, troubleshooting guide, FAQ; update existing docs
- **Reference:** `docs/`

**Acceptance Criteria:**
- Operator dashboard is functional
- Deployment is automated and repeatable
- Documentation is comprehensive and accurate
- New operators can get started from docs

---

## 5. TESTING AND VALIDATION

### Unit Tests
- **Coverage:** >80% across all new code
- **Focus:** Individual components (scheduler, billing engine, API handlers)
- **Tools:** Jest, TypeScript
- **Location:** `packages/*/src/*.test.ts`, `apps/*/src/*.test.tsx`

### Integration Tests
- **Scope:** Multi-tenant database, Trigger.dev jobs, API endpoints
- **Requirements:** Docker (Postgres, Trigger.dev)
- **Key Tests:**
  - Tenant A cannot access Tenant B's data (RLS verification)
  - Trigger.dev job executes migration end-to-end
  - API endpoints return correct data with proper auth
  - Billing calculations match expected values
- **Command:** `pnpm test:integration`

### E2E Tests
- **Scenarios:**
  1. Full tenant onboarding → migration setup → sync → cutover
  2. Multi-tenant isolation (create 2 tenants, verify no cross-access)
  3. Billing flow (usage → invoice → payment)
  4. Failed job retry and recovery
- **Tools:** Playwright or Cypress
- **Command:** `pnpm test:e2e`

### Property Tests
- **Idempotency:** Re-running migrations creates no duplicates (verify via ledger)
- **Tenant Isolation:** Querying as Tenant A never returns Tenant B's data
- **Billing Accuracy:** Aggregated usage matches actual resource consumption
- **Tools:** Fast-check or property testing framework

### Validation Checklist

Before marking workplan complete:

- [ ] All lint checks pass: `pnpm lint`
- [ ] All type checks pass: `pnpm typecheck`
- [ ] All unit tests pass: `pnpm test`
- [ ] All integration tests pass: `pnpm test:integration`
- [ ] E2E tests pass: `pnpm test:e2e`
- [ ] RLS policies verified (cross-tenant access blocked)
- [ ] Trigger.dev jobs execute with retries
- [ ] Billing calculations verified (manual spot-checks)
- [ ] API documentation is accurate and complete
- [ ] Web UI is bilingual (EN/NL)
- [ ] Deployment documentation works (fresh deploy to dev/staging)
- [ ] No secrets in repository
- [ ] Self-host edition still works (regression test)
- [ ] Idempotency preserved in managed mode

### Success Metrics

1. **Functional:** Multi-tenant SaaS operational with successful migrations
2. **Technical:** All gates green, RLS enforced, jobs durable
3. **Operational:** Deployment automated, monitoring in place
4. **Business:** Cost-recovery billing accurate and collectible
