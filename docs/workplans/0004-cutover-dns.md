# Workplan 0004: Cutover & DNS Management

> ⚠️ **SUPERSEDED by [workplan 0009](./0009-cutover-integration.md)** (2026-07-09) — kept as
> history, do not execute from this file. Verified state at supersession: state machine,
> verification scaffolding, DNS types and rollback orchestrator exist **unit-tested against
> fakes only**; nothing is persisted, wired to the worker/API, or performs real DNS I/O
> (Phase 4 never started).

**Status**: SUPERSEDED (was: Phase 1 & 2 COMPLETED, Phase 3 IN_PROGRESS)

> **Reality check**: All components listed below are **unit-tested against fakes only**. No
> integration with the worker/API exists. No real DNS I/O is performed. Phase 4 (integration)
> was never started. See workplan 0009 for the current state.

## Overview

This workplan implements the complete cutover lifecycle with DNS management, verification, and rollback capabilities. The cutover process enables safe migration from source systems (O365/Google) to target systems (JMAP/IMAP/DAV) with full control and visibility.

## Phases

### Phase 1: Core Cutover Logic ✅ COMPLETED

**Status**: All gates green, unit tests passing

**Components Implemented**:
- `packages/core/src/cutover-state.ts` - State machine with 7 states and valid transitions
- `packages/core/src/verification.ts` - Verification engine for all data types
- `packages/core/src/cutover.ts` - Cutover manager implementation
- `packages/core/src/cutover-state.unit.test.ts` - 24 comprehensive unit tests

**Features**:
- State machine with 7 states: PREPARING → READY_FOR_CUTOVER → CUTOVER_IN_PROGRESS → GRACE_PERIOD → COMPLETED/ROLLED_BACK/FAILED
- Verification engine checking mail, calendar, contacts
- Grace period monitoring (default 72 hours)
- Rollback capabilities during cutover and grace period
- Event logging for audit trail
- Idempotent operations

**Gates**:
- ✅ Lint: Passing
- ✅ Typecheck: Passing  
- ✅ Unit Tests: 37 tests passing

### Phase 2: DNS Management ✅ COMPLETED

**Status**: All gates green, unit tests passing

**Components Implemented**:
- `packages/core/src/dns-manager.ts` - DNS management interface and implementation
- DNS record types (MX, TXT, SPF, DKIM, DMARC, Autodiscover)
- DNS propagation verification
- TTL management
- Rollback DNS changes

**Documentation**:
- `docs/dns-management.md` - DNS configuration guide

**Gates**:
- ✅ Lint: Passing
- ✅ Typecheck: Passing
- ✅ Unit Tests: 11 tests passing

### Phase 3: Rollback Mechanisms ✅ COMPLETED

**Status**: All gates green, unit tests passing

**Components Implemented**:
- `packages/core/src/rollback-orchestrator.ts` - Comprehensive rollback orchestrator
- Multi-step rollback coordination
- Graceful failure handling
- Timeout protection
- Notification support

**Features**:
- Validates rollback prerequisites
- Executes rollback in defined sequence
- Continues with remaining steps even if one fails
- Preserves audit trail
- Supports configurable rollback options

**Documentation**:
- `docs/rollback-mechanisms.md` - Rollback mechanisms guide

**Gates**:
- ✅ Lint: Passing
- ✅ Typecheck: Passing
- ✅ Unit Tests: 14 tests passing

### Phase 4: Integration & Testing TODO

**Goal**: End-to-end testing and integration

**Tasks**:
- Integration tests for full cutover flow
- E2E tests with real providers
- Performance testing
- Failure scenario testing

## Safety Requirements

1. **Non-destructive by default**: Never auto-delete/overwrite on target
2. **Grace period**: Minimum 72 hours before auto-completion
3. **Verification threshold**: 95% verification score required
4. **Rollback capability**: Available during cutover and grace period
5. **Event logging**: All state changes logged with audit trail
6. **User confirmation**: Required for critical transitions

## Dependencies

- Phase 1 must be complete before Phase 2
- DNS management requires provider API integration
- Rollback requires complete state tracking

## Success Criteria

- ✅ Phase 1: State machine, verification, cutover manager implemented
- ⏳ Phase 2: DNS management with propagation verification
- ⏳ Phase 3: Full rollback capabilities
- ⏳ Phase 4: All tests passing, documentation complete
