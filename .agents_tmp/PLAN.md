# Workplan 0006 — Web UI & User Experience

## 1. OBJECTIVE

Create a comprehensive, bilingual (English/Dutch) web application that enables families and SMBs to configure, monitor, and manage sovereign migrations from O365/Google to EU targets (JMAP/IMAP/DAV). The UI must be accessible (WCAG 2.2 AA), intuitive for non-technical users, and support the complete migration journey from connection through cutover.

## 2. CONTEXT SUMMARY

**Current State:**
- Workplan 0001 ✅: JMAP mail sync (one-way shadow, idempotent)
- Workplan 0002 ✅: IMAP/DAV target family (Soverin/openDesk)
- Workplan 0003 🔄: CalDAV/CardDAV/WebDAV (calendar, contacts, files) - IN PROGRESS
- Workplan 0004 🔄: Cutover & DNS Management - Phase 1-3 COMPLETE, Phase 4 TODO
- Workplan 0005 🔄: Managed Edition Backend - Phase 1-2 COMPLETE (schema, Trigger.dev), Phase 3-6 TODO (API, billing backend)

**What Workplan 0006 Addresses:**
This workplan delivers the **shared web UI layer** that serves both the self-host and managed editions. According to ADR-0003 and Solution Architecture §7.3, the UI is **identical across both editions** - only the backend services it connects to differ:

| Layer | Self-host Edition | Managed Edition |
|-------|------------------|-----------------|
| **UI (Workplan 0006)** | Same Next.js app | Same Next.js app |
| **Orchestration** | In-process (croner) | Trigger.dev |
| **Database** | SQLite / small Postgres | Managed Postgres + RLS |
| **Auth (Workplan 0006 T2)** | Local email/password | SSO/OIDC (Zitadel) |
| **Billing (Workplan 0006 T7)** | Not applicable | Mollie integration |

**Dependencies:**
- **API Layer:** Workplan 0005 Phase 3 must be complete (REST/GraphQL API endpoints)
- Core sync engines (packages/connectors, packages/engines, packages/core)
- Ledger for idempotency (packages/ledger)
- Cutover logic (packages/core/src/cutover.ts)
- Multi-tenant foundation (Workplan 0005)

**Constraints:**
- Bilingual UI: English + Dutch (ADR-0013, Solution Architecture §23)
- Accessibility: WCAG 2.2 AA compliance
- Two editions: UI must work with both self-host (local auth) and managed (SSO) backends
- No secrets in client; all sensitive operations via API
- Responsive design (desktop, tablet, mobile)
- Must gracefully degrade for self-host edition (no billing features)

**Relevant Documentation:**
- `docs/architecture/solution-architecture.md` §7 (delivery model), §23 (i18n)
- `docs/adr/0003-two-editions-one-core.md` (shared UI, different backends)
- `docs/workplans/0005-implementation-summary.md` (managed edition backend context)
- `docs/workplans/0004-cutover-dns.md` (cutover workflow)
- `docs/rls-guide.md` (tenant isolation)

## 3. APPROACH OVERVIEW

**Chosen Approach:** Next.js 15 (latest) application with:
- **Tailwind CSS v4** with CSS-first configuration and design tokens
- **shadcn/ui v2** for accessible, customizable components
- **next-intl** for bilingual support (EN/NL) - modern, App Router compatible
- **TanStack Query v5** for server state management (caching, sync, optimistic updates)
- **Zustand v5** for lightweight client state
- **React Hook Form v7** for complex forms (wizards)
- **Playwright 1.49+** for E2E testing
- **Authentication:** NextAuth.js v5 (Auth.js) for both OAuth (managed) and local (self-host)

**Rationale:**
- Next.js 15 provides the latest features: Turbopack (faster dev), App Router, Server Actions
- Tailwind v4 offers improved performance and CSS-first configuration
- shadcn/ui v2 provides production-ready accessible components
- next-intl is the modern choice for Next.js 15 App Router i18n
- TanStack Query v5 has excellent TypeScript support and devtools
- The stack aligns with the existing TypeScript/Node ecosystem (pnpm monorepo)
- All tools are production-ready with strong community support and active maintenance

**Alternative Considered:**
- Remix: Similar capabilities but smaller ecosystem, less mature
- Vite + React: More manual setup for routing, SSR, and deployment
- **Decision:** Next.js 15 is the most mature choice with best DX, especially for this use case requiring SSR, i18n, and API integration

**Edition Adaptation Strategy:**
The UI will detect the deployment mode and adapt:
- **Managed edition:** Full feature set including billing, multi-tenant features
- **Self-host edition:** Gracefully hide billing features, use local auth flows
- Feature flags via environment variables control edition-specific behavior

**Relationship to Workplan 0005:**
- **Workplan 0005** delivers the **backend API and infrastructure** (multi-tenant schema, Trigger.dev integration, billing backend)
- **Workplan 0006** delivers the **frontend web UI** that consumes that API
- They are **complementary layers**, not overlapping work
- The UI (0006) will be built to work with both:
  - The managed backend (Workplan 0005)
  - A self-host backend (simpler, in-process scheduler, local auth)

## 4. IMPLEMENTATION STEPS

### T1 — UI Architecture & Setup
**Goal:** Establish web application foundation with latest stable tools and best practices.

**Method:**
1. Initialize **Next.js 15** (latest stable) with App Router and TypeScript in `apps/web/`
2. Configure **Tailwind CSS v4** with CSS-first configuration and design tokens
3. Set up i18n with **next-intl** (modern, App Router compatible) for EN/NL locales
4. Install and configure **shadcn/ui v2** with latest components
5. Set up **TanStack Query v5** (React Query) and **Zustand v5** for state management
6. Configure **Biome** (or ESLint 9+) + **Prettier 3** + **Husky 9** for code quality
7. Establish testing infrastructure: **Vitest 2**, **@testing-library/react 16**, **Playwright 1.49+**
8. Set up **Turbopack** for faster local development (Next.js 15 default)

**Deliverables:**
- `apps/web/` - Next.js 15 application with App Router structure
- `apps/web/src/components/` - Reusable UI components using shadcn/ui
- `apps/web/src/lib/` - Utilities, API client (TanStack Query), auth helpers
- `apps/web/src/locales/` - EN/NL translation files (next-intl format)
- `apps/web/src/styles/` - Global styles, Tailwind v4 CSS
- `apps/web/playwright/` - E2E test suite
- `apps/web/public/` - Static assets (logos, icons)
- `apps/web/next.config.ts` - Modern Next.js 15 configuration

**Acceptance Criteria:**
- `pnpm --filter @openmig/web dev` starts with Turbopack
- Locale switching works (EN ↔ NL) with client-side persistence
- Basic layout with responsive navigation (header, sidebar, main content)
- All gates green: lint, typecheck, test
- Lighthouse performance ≥ 90 on initial load

---

### ✅ QUALITY GATE 1: Foundation Verification
**Before proceeding to T2, verify:**
- `pnpm lint` - Zero warnings, zero errors
- `pnpm typecheck` - No TypeScript errors
- `pnpm test` - All unit tests passing (baseline test suite)
- `pnpm build` - Production build succeeds without errors
- Lighthouse audit: Performance ≥ 90, Accessibility ≥ 95, Best Practices ≥ 90
- Next.js 15 App Router structure verified
- Turbopack dev server starts in < 5 seconds
- i18n routing configured and tested for both locales

**If any gate fails:** Fix issues before proceeding to T2.

---

### T2 — Authentication & Authorization
**Goal:** Implement secure authentication for both editions using latest libraries.

**Method:**
1. **Managed edition:** OIDC integration with **NextAuth.js v5 (Auth.js)**
   - OAuth 2.0 / OIDC with Zitadel/Keycloak
   - Authorization code flow with PKCE
   - Session management with **Secure HTTP-only cookies**
   - Automatic token refresh with background renewal

2. **Self-host edition:** Local authentication
   - Email/password with **bcryptjs** or **argon2** (preferred)
   - JWT-based sessions with **Jose** (lightweight, modern)
   - Password reset with secure, time-limited tokens
   - Rate limiting on authentication endpoints

3. **Role-based access control (RBAC):**
   - Tenant Admin: full access
   - Member: can configure and monitor migrations
   - Viewer: read-only access
   - Middleware guards for protected routes

**Deliverables:**
- Login page with OAuth buttons and email/password form
- Registration flow (managed edition only) with email verification
- Password reset flow with secure token handling
- Session management middleware (Next.js 15 middleware)
- Role-based UI guards and permission hooks
- Authentication context provider for React

**Acceptance Criteria:**
- Users can authenticate via OAuth (managed) or local (self-host)
- Session persists across page reloads with secure cookies
- Unauthorized access redirects to login with return URL
- Role-based UI elements dynamically show/hide
- Logout clears all sessions and tokens
- Password policies enforced (min length, complexity)
- Rate limiting prevents brute force attacks

---

### ✅ QUALITY GATE 2: Authentication Security & Functionality
**Before proceeding to T3, verify:**
- `pnpm lint` - Zero warnings, zero errors
- `pnpm typecheck` - No TypeScript errors
- `pnpm test` - All auth unit tests passing (login, logout, session, RBAC)
- OAuth flow tested with mock provider (PKCE flow verified)
- Local auth tested with bcrypt/argon2 password hashing
- Session cookies marked as `Secure`, `HttpOnly`, `SameSite=Strict`
- Rate limiting configured and tested (max 5 attempts per minute)
- Password policy enforced (min 12 chars, complexity requirements)
- Role-based access control tested for all three roles
- Security headers configured (CSP, X-Frame-Options, etc.)
- `pnpm build` succeeds with no auth-related warnings

**If any gate fails:** Fix security or functionality issues before proceeding to T3.

---

### T3 — Tenant Dashboard
**Goal:** Create main dashboard for migration overview with real-time updates.

**Method:**
1. Display tenant overview (mailboxes, mappings, status) using **TanStack Query**
2. Show active migrations with **real-time progress** via WebSocket or Server-Sent Events
3. Display recent activity and notifications with **toast notifications**
4. Provide quick actions (start sync, configure, cutover) with **optimistic updates**
5. Show usage statistics (managed edition) with **recharts** or **nivo** charts
6. Implement **infinite loading** for long lists

**Deliverables:**
- Dashboard home page with overview cards and charts
- Tenant settings page (name, logo, preferences, timezone)
- User management page (invite, roles, remove) with email invitations
- Notification center component with unread count
- Usage dashboard (managed edition) with interactive charts
- Empty states and loading skeletons

**Acceptance Criteria:**
- Dashboard loads with tenant data within 2 seconds (Core Web Vitals)
- All mappings and their status clearly visible with color-coded indicators
- Quick actions functional with optimistic UI updates
- Real-time updates via WebSocket/SSE (≤ 5s latency)
- Navigation to detailed views preserves state
- Responsive layout works on mobile, tablet, desktop
- Accessibility: keyboard navigation, screen reader support

---

### ✅ QUALITY GATE 3: Dashboard & Real-time Features
**Before proceeding to T4, verify:**
- `pnpm lint` - Zero warnings, zero errors
- `pnpm typecheck` - No TypeScript errors
- `pnpm test` - All dashboard unit tests passing (components, hooks, queries)
- TanStack Query caching and refetching tested
- WebSocket/SSE connection tested with mock server
- Optimistic updates rollback on error
- Empty states and loading skeletons implemented
- Responsive design tested on mobile, tablet, desktop
- Accessibility audit: keyboard navigation, screen reader (axe-core)
- Lighthouse: Performance ≥ 90, Accessibility ≥ 95
- `pnpm build` succeeds
- **Git Commit:** `feat: dashboard with real-time updates and optimistic UI`
- **Git Tag:** `quality-gate-3-dashboard-complete`

**If any gate fails:** Fix issues before proceeding to T4.

---

### T4 — Migration Configuration Wizard
**Goal:** Guide users through migration setup with a modern, responsive wizard.

**Method:**
1. Multi-step wizard with **progress indicator** and step validation using **React Hook Form v7**
2. **Step 1:** Source connection (O365/Google OAuth buttons or IMAP credentials form)
3. **Step 2:** Target connection (JMAP/IMAP/DAV credentials with auto-discovery)
4. **Step 3:** Scope selection (interactive folder tree with search and multi-select)
5. **Step 4:** Sync configuration (schedule, behavior, concurrency with presets)
6. **Step 5:** Review and confirm with detailed summary
7. **Form features:** field-level validation, async validation, error messages in EN/NL

**Deliverables:**
- Wizard component with progress stepper, validation, and step navigation
- Connection testing with real-time feedback and error details
- Scope picker with collapsible folder tree, search, and bulk selection
- Configuration form with sensible defaults and helpful tooltips
- Summary and confirmation screen with editable sections
- Save as draft functionality with auto-save
- Draft recovery on page reload

**Acceptance Criteria:**
- Wizard completes and creates a valid mapping in the backend
- All steps validated before proceeding (sync validation where applicable)
- Connection tests provide clear success/failure with actionable feedback
- Configuration saved to backend and usable immediately
- Can return to previous steps and modify without data loss
- Auto-save drafts every 30 seconds
- Form validation messages in both EN and NL
- Keyboard accessible with proper focus management

---

### ✅ QUALITY GATE 4: Wizard & Form Validation
**Before proceeding to T5, verify:**
- `pnpm lint` - Zero warnings, zero errors
- `pnpm typecheck` - No TypeScript errors
- `pnpm test` - All wizard unit tests passing (form validation, step navigation, auto-save)
- React Hook Form validation tested for all fields
- Async validation (connection tests) tested with mock API
- Draft auto-save tested (30-second interval, recovery on reload)
- Multi-language validation messages (EN/NL) verified
- Keyboard navigation through wizard steps tested
- Accessibility audit: form labels, error announcements, focus management
- Integration tests: full wizard flow with mock backend
- `pnpm build` succeeds
- **Git Commit:** `feat: multi-step migration wizard with auto-save and validation`
- **Git Tag:** `quality-gate-4-wizard-complete`

**If any gate fails:** Fix issues before proceeding to T5.

---

### T5 — Migration Monitoring
**Goal:** Provide real-time visibility into migration progress with modern data visualization.

**Method:**
1. Live progress indicators using **WebSocket** or **Server-Sent Events** for active syncs
2. Detailed statistics dashboard with **recharts** (items synced, errors, duration, bytes transferred)
3. Error reporting with **grouped, actionable messages** and suggested fixes
4. Real-time log viewer with **virtualized scrolling**, filtering, and search
5. Historical sync data with **trend analysis** and comparative charts
6. **Drill-down capabilities** from summary to individual item status

**Deliverables:**
- Migration detail page with live updates and progress visualization
- Progress bars with percentage, item counts, and estimated time remaining
- Statistics dashboard with interactive charts (created, skipped, failed, bytes)
- Error list with filtering by type, severity, folder, and date range
- Log viewer with real-time streaming, search, and export (JSON, CSV)
- Export reports (PDF, CSV) with branding and detailed breakdowns
- Empty states, loading skeletons, and error states

**Acceptance Criteria:**
- Real-time updates via WebSocket/SSE with ≤ 3s latency
- Statistics accurately reflect backend data with automatic refresh
- Errors clearly displayed with context, error codes, and actionable suggestions
- Logs accessible with virtualized scrolling for performance (10k+ entries)
- Search filters applied instantly with result count
- Historical data viewable with interactive charts and date range selection
- Export functionality generates properly formatted reports
- All visualizations accessible (keyboard, screen reader, color-blind safe)

---

### ✅ QUALITY GATE 5: Monitoring & Data Visualization
**Before proceeding to T6, verify:**
- `pnpm lint` - Zero warnings, zero errors
- `pnpm typecheck` - No TypeScript errors
- `pnpm test` - All monitoring unit tests passing (charts, logs, error handling)
- WebSocket/SSE reconnection logic tested
- Virtualized scrolling tested with 10k+ log entries
- Chart accessibility (keyboard navigation, screen reader labels)
- Export functionality tested (PDF, CSV generation)
- Error grouping and filtering tested
- Historical data queries performant (< 2s for 30-day range)
- Lighthouse: Performance ≥ 90, Accessibility ≥ 95
- `pnpm build` succeeds
- **Git Commit:** `feat: real-time migration monitoring with charts and logs`
- **Git Tag:** `quality-gate-5-monitoring-complete`

**If any gate fails:** Fix issues before proceeding to T6.

---

### T6 — Cutover Wizard
**Goal:** Guide users through cutover with comprehensive safety checks and modern UX.

**Method:**
1. Pre-cutover verification checklist with **progress tracking** and **detailed explanations**
2. DNS/MX record guidance with **provider-specific templates** (Cloudflare, Route53, OVH, etc.)
3. Verification score display with **visual progress indicator** (95% threshold required)
4. Grace period configuration with **recommended settings** and explanations
5. Rollback options with **step-by-step instructions** and safety confirmations
6. Bilingual communication templates (EN/NL) with **customization options**
7. **Confirmation dialogs** with explicit understanding requirements

**Deliverables:**
- Cutover wizard with multi-step flow and verification gate
- DNS configuration guide with provider-specific examples (MX, SPF, DKIM, DMARC, MTA-STS)
- Pre-flight checks with pass/fail indicators and detailed explanations
- Cutover confirmation with multiple safety warnings and checkboxes
- Rollback wizard with step-by-step instructions and confirmation
- Email/SMS templates (EN/NL) for user communication with preview
- DNS propagation checker with real-time status
- Cutover timeline visualization

**Acceptance Criteria:**
- Cutover only proceeds when verification ≥ 95% with clear failure reasons
- DNS records clearly explained with copy-paste templates for major providers
- Rollback available during cutover and grace period with full reversibility
- All communications available in EN and NL with professional tone
- Safety warnings require explicit checkbox confirmations
- DNS propagation checker shows real-time status across multiple DNS servers
- Timeline visualization shows expected cutover progression
- All steps keyboard accessible with proper focus management

---

### ✅ QUALITY GATE 6: Cutover Safety & Verification
**Before proceeding to T7, verify:**
- `pnpm lint` - Zero warnings, zero errors
- `pnpm typecheck` - No TypeScript errors
- `pnpm test` - All cutover unit tests passing (verification logic, state transitions)
- Verification gate tested (95% threshold enforced)
- DNS templates tested for major providers (Cloudflare, Route53, OVH, etc.)
- DNS propagation checker tested with real DNS servers
- Rollback flow tested end-to-end
- Safety confirmations require explicit user action
- Bilingual templates (EN/NL) verified by native speakers
- Accessibility audit: all wizards keyboard accessible, screen reader friendly
- Integration tests: full cutover flow with mock backend
- `pnpm build` succeeds
- **Git Commit:** `feat: cutover wizard with verification gates and DNS guidance`
- **Git Tag:** `quality-gate-6-cutover-complete`

**If any gate fails:** Fix issues before proceeding to T7.

---

### T7 — Billing UI (Managed Edition Only)
**Goal:** Provide billing transparency and management for the managed edition.

**Note:** This task is **only for the managed edition**. Self-host edition does not include billing.

**Method:**
1. Usage dashboard with **recharts** (mailboxes, sync runs, storage, API calls)
2. Invoice history with PDF downloads via **react-pdf**
3. Payment method management with **Mollie** integration (secure, tokenized)
4. Plan selection with feature comparison and upgrade flow
5. Cost estimates and projections with **interactive charts**
6. **Edition detection:** Hide billing UI entirely in self-host mode

**Deliverables:**
- Billing dashboard with usage metrics and interactive charts
- Invoice list with secure PDF download links
- Payment method setup and management (Mollie components)
- Plan selection page with feature comparison table
- Billing settings and notification preferences
- Usage projections and cost calculator with scenario modeling
- Empty states for no invoices/payment methods

**Acceptance Criteria:**
- Billing UI only visible in managed edition (feature flag controlled)
- Usage accurately reflects backend metrics from Workplan 0005
- Invoices downloadable as properly formatted PDFs
- Payment methods managed securely via Mollie (no raw card data in app)
- Plan changes effective immediately with confirmation
- Cost projections match actual usage within 5%
- All billing flows accessible and bilingual (EN/NL)
- Graceful fallback if billing service unavailable

---

### ✅ QUALITY GATE 7: Billing Security & Functionality
**Before proceeding to T8, verify:**
- `pnpm lint` - Zero warnings, zero errors
- `pnpm typecheck` - No TypeScript errors
- `pnpm test` - All billing unit tests passing (usage calculation, invoice generation, payment flows)
- Mollie integration tested with test mode (no real charges)
- PDF generation tested with various invoice formats
- Payment method tokenization verified (PCI compliance)
- Usage metrics match backend within 5% tolerance
- Edition detection working (billing hidden in self-host mode)
- Accessibility audit: billing forms and charts accessible
- Security review: no sensitive data in client, secure API calls
- Integration tests: full billing flow with mock Mollie
- `pnpm build` succeeds
- **Git Commit:** `feat: billing UI with Mollie integration and invoice management`
- **Git Tag:** `quality-gate-7-billing-complete`

**If any gate fails:** Fix issues before proceeding to T8.

---

### T8 — Help & Documentation
**Goal:** Provide comprehensive in-app help resources.

**Method:**
1. Help center with searchable documentation
2. Contextual help tooltips throughout the app
3. Migration best practices guide
4. Troubleshooting guides
5. Support contact integration

**Deliverables:**
- Help center page with categories and search
- Contextual help components (tooltips, side panels)
- Bilingual documentation (EN/NL)
- Support contact form with ticket creation
- FAQ section with common questions
- Video tutorials (optional, future)

**Acceptance Criteria:**
- Help content searchable and navigable
- All docs available in EN and NL
- Contextual help appears at relevant points
- Support contact functional and creates tickets
- Search returns relevant results quickly

---

### ✅ QUALITY GATE 8: Help & Documentation Completeness
**Before proceeding to T9, verify:**
- `pnpm lint` - Zero warnings, zero errors
- `pnpm typecheck` - No TypeScript errors
- `pnpm test` - All help component unit tests passing
- Search functionality tested with various queries
- All documentation content available in EN and NL
- Contextual help tooltips tested at all designated points
- Support contact form tested (ticket creation verified)
- Search performance: results returned in < 500ms
- Accessibility audit: help center keyboard accessible, screen reader friendly
- `pnpm build` succeeds
- **Git Commit:** `feat: help center with search and contextual assistance`
- **Git Tag:** `quality-gate-8-help-complete`

**If any gate fails:** Fix issues before proceeding to T9.

---

### T9 — Accessibility & Internationalization
**Goal:** Ensure WCAG 2.2 AA compliance and full bilingual support.

**Method:**
1. WCAG 2.2 AA compliance audit and remediation
2. Keyboard navigation testing throughout app
3. Screen reader compatibility testing (NVDA, VoiceOver)
4. i18n implementation with proper locale handling
5. Date/time/currency localization
6. Color contrast verification

**Deliverables:**
- Accessibility audit report with remediation plan
- Keyboard navigation for all interactive elements
- Screen reader test results and fixes
- Complete EN/NL translation coverage
- Locale-aware formatting (dates, times, numbers, currencies)
- Accessibility testing in CI pipeline

**Acceptance Criteria:**
- Lighthouse accessibility score ≥ 95
- All interactive elements keyboard accessible
- Screen reader announces all content correctly
- All UI elements available in EN and NL
- No accessibility violations in automated tests
- Color contrast meets WCAG AA standards

---

### ✅ QUALITY GATE 9: Accessibility & i18n Compliance
**Before proceeding to T10, verify:**
- `pnpm lint` - Zero warnings, zero errors
- `pnpm typecheck` - No TypeScript errors
- `pnpm test` - All i18n and accessibility unit tests passing
- Lighthouse accessibility score ≥ 95 (verified on all major pages)
- Full keyboard navigation tested (Tab, Shift+Tab, Enter, Space, Arrow keys)
- Screen reader testing completed (NVDA on Windows, VoiceOver on macOS)
- All UI elements have proper ARIA labels and roles
- Color contrast ratios meet WCAG AA (4.5:1 for normal text, 3:1 for large text)
- Focus indicators visible and meaningful
- All content available in EN and NL (no hardcoded English)
- Locale switching tested and working correctly
- Date/time/number formatting locale-aware
- `pnpm build` succeeds
- **Git Commit:** `feat: WCAG 2.2 AA compliance and full bilingual support`
- **Git Tag:** `quality-gate-9-a11y-complete`

**If any gate fails:** Fix accessibility or i18n issues before proceeding to T10.

---

### T10 — Testing & Quality Assurance
**Goal:** Comprehensive testing for reliability and quality.

**Method:**
1. Unit tests for components and utilities (≥ 80% coverage)
2. Integration tests for user flows
3. E2E tests with Playwright for critical journeys
4. Accessibility testing with axe
5. Visual regression testing
6. Performance testing and benchmarks

**Deliverables:**
- Unit test suite with ≥ 80% code coverage
- Integration test suite for key flows
- E2E test suite covering all user journeys:
  - New tenant onboarding
  - Migration setup and execution
  - Cutover with verification
  - Billing management
- Accessibility test report
- Performance benchmarks and monitoring

**Acceptance Criteria:**
- All tests passing in CI pipeline
- ≥ 80% code coverage (measured by Vitest)
- All critical user journeys E2E tested
- No accessibility violations (axe)
- Performance within acceptable bounds:
  - Page load < 2s on 3G
  - Interaction response < 100ms
  - Lighthouse performance ≥ 90

---

### ✅ QUALITY GATE 10: Final Verification & Release Readiness
**Before marking workplan complete, verify:**
- `pnpm lint` - Zero warnings, zero errors
- `pnpm typecheck` - No TypeScript errors
- `pnpm test` - All unit tests passing (≥ 80% coverage)
- `pnpm test:integration` - All integration tests passing
- `pnpm test:e2e` - All E2E tests passing (critical journeys)
- `pnpm build` - Production build succeeds
- Lighthouse scores across all pages:
  - Performance ≥ 90
  - Accessibility ≥ 95
  - Best Practices ≥ 90
  - SEO ≥ 90
- Accessibility audit complete (axe-core + manual testing)
- Cross-browser testing: Chrome, Firefox, Safari, Edge
- Mobile responsive testing: iOS Safari, Android Chrome
- Edition detection working (managed vs self-host)
- Security review completed (no secrets in client, secure API calls)
- Performance benchmarks met (Core Web Vitals)
- Documentation complete (user guide, API docs, deployment guide)
- **Git Commit:** `feat: complete web UI with all features and comprehensive testing`
- **Git Tag:** `wp0006-web-ui-complete`
- **Release Note:** Workplan 0006 complete - Web UI ready for production

**If any gate fails:** Fix issues before declaring workplan complete.

---

## 5. TESTING AND VALIDATION

### Unit Tests
**Scope:**
- Component rendering and user interactions
- Utility functions (i18n helpers, formatters)
- Form validation logic
- API client error handling

**Tools:** Vitest + Testing Library

**Acceptance:** ≥ 80% code coverage, all tests passing

---

### Integration Tests
**Scope:**
- Authentication flows (login, register, password reset)
- Migration configuration wizard
- Cutover process
- Billing operations
- Role-based access control

**Tools:** Vitest + Testing Library + MSW (mock service worker)

**Acceptance:** All critical flows tested, no regressions

---

### E2E Tests
**Scope:**
- Complete user journeys with real backend:
  1. New tenant signup and onboarding
  2. Source and target connection
  3. Migration configuration and execution
  4. Real-time monitoring
  5. Cutover with verification
  6. Billing and invoice management

**Tools:** Playwright

**Acceptance:** All critical journeys pass, cross-browser testing (Chrome, Firefox, Safari)

---

### Accessibility Tests
**Scope:**
- Automated axe testing for common violations
- Keyboard navigation verification
- Screen reader compatibility (NVDA, VoiceOver)
- Color contrast verification
- Focus management

**Tools:** axe-core, Playwright, manual testing

**Acceptance:** No serious accessibility violations, WCAG 2.2 AA compliant

---

### Performance Tests
**Scope:**
- Page load time measurement
- Interaction response time
- Bundle size analysis
- Lighthouse scoring

**Tools:** Lighthouse, Web Vitals, bundle analyzer

**Acceptance:**
- Lighthouse performance ≥ 90
- First Contentful Paint < 1.5s
- Time to Interactive < 3.5s
- Bundle size < 500KB (gzipped)

---

### Definition of Done

**For each task:**
- ✅ Code implemented and reviewed
- ✅ Unit tests written and passing
- ✅ Integration/E2E tests where applicable
- ✅ Documentation updated
- ✅ Accessibility requirements met
- ✅ Bilingual (EN/NL) support complete
- ✅ All gates green (lint, typecheck, test)

**For the workplan:**
- ✅ All 10 tasks complete
- ✅ Web app deployed and accessible
- ✅ All user journeys functional end-to-end
- ✅ Accessibility audit passed (WCAG 2.2 AA)
- ✅ E2E tests passing in CI
- ✅ Performance benchmarks met
- ✅ Documentation complete (user guide, API docs)
