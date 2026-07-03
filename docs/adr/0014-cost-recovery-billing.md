# ADR-0014: Cost-recovery billing (no profit) for the managed edition

- **Status:** Accepted
- **Date:** 2026-06-20

## Context
The managed service should be sustainable, not profit-seeking.

## Decision
Price the managed edition at **cost recovery**: allocated infrastructure + operations split across tenants. Suggested model: a low flat monthly per tenant for the shared baseline + marginal pass-through for storage/egress, reviewed to stay break-even. The **self-host edition is free** (user runs their own infra). Cost drivers: Trigger.dev (self-host/cloud), managed Postgres, object storage, egress (mostly initial copy), reseller target licensing if any. EU PSP (e.g., Mollie).

## Consequences
- Predictable, fair pricing; no profit margin to defend.
- Metering derived from the ledger; periodic review to stay break-even.

## Alternatives considered
- For-profit pricing: out of scope per project intent.
