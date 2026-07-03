# ADR-0003: Two editions from one core (self-host + managed)

- **Status:** Accepted
- **Date:** 2026-06-20

## Context
Audience spans a self-hosting hobbyist (NAS/Pi/Spark, possibly single-user) and customers without a server who need a managed service.

## Decision
Ship **one codebase** with two editions. Only the control-plane differs: orchestration, state, tenancy, secrets, auth, provisioning, billing. The migration core, connectors, engines, and UI are identical. See solution-architecture.md section 7.3.

## Consequences
- Identical migration behavior and idempotency across editions.
- Shared code must not hard-depend on managed-only services.
- Clear interfaces (`Scheduler`, `TargetProvisioner`) isolate the differences.

## Alternatives considered
- Separate products: rejected — duplicate logic, divergent behavior.
