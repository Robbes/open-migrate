# ADR-0001: License is Apache-2.0

- **Status:** Accepted
- **Date:** 2026-06-20

## Context
The project optimizes for maximal adoption AND being open. Copyleft (AGPL) protects "stays open" but deters commercial/MSP adoption.

## Decision
License the whole product under **Apache-2.0** (OSI-approved, permissive, includes a patent grant).

## Consequences
- Maximizes adoption; MSPs/communities and commercial users can build on and host it.
- No copyleft protection: a third party may run the code as a closed SaaS (accepted trade-off).
- Apache-2.0 source headers + NOTICE conventions apply.

## Alternatives considered
- AGPL-3.0: rejected — would limit the "maximal use" goal.
- MIT: viable but lacks the explicit patent grant.
