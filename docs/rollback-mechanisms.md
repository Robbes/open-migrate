# Rollback Mechanisms

This document describes the comprehensive rollback capabilities implemented in OpenMigrate for safe cutover operations.

## Overview

Rollback is a critical safety feature that allows users to revert a cutover operation if issues are discovered during the grace period or cutover itself. The rollback orchestrator coordinates multiple rollback steps to ensure a complete and consistent reversal.

## Components

### Rollback Orchestrator

The `RollbackOrchestrator` class (`packages/core/src/rollback-orchestrator.ts`) coordinates the complete rollback process:

**Key Features:**
- **Multi-step rollback**: Executes rollback in a defined sequence
- **Graceful failure handling**: Continues with other steps even if one fails
- **Timeout protection**: Prevents rollback from running indefinitely
- **Comprehensive logging**: All rollback actions are logged for audit trail
- **Notification support**: Alerts users when rollback is initiated

**Rollback Steps:**
1. **Notify Users** - Sends email notifications about the rollback
2. **Rollback DNS** - Restores previous DNS records
3. **Restore Data** - Restores data from backup
4. **Update State** - Updates cutover state to ROLLED_BACK
5. **Preserve Logs** - Archives logs for audit purposes

### Rollback Configuration

```typescript
interface RollbackConfig {
  rollbackDns: boolean;        // Rollback DNS records
  restoreData: boolean;        // Restore data from backup
  updateState: boolean;        // Update cutover state
  notifyUsers: boolean;        // Send notifications
  preserveLogs: boolean;       // Preserve logs for audit
  timeoutMinutes: number;      // Maximum rollback time
}
```

### Rollback Validation

Before executing a rollback, the orchestrator validates that rollback is possible:

**Valid States for Rollback:**
- `CUTOVER_IN_PROGRESS` - During active cutover
- `GRACE_PERIOD` - During grace period monitoring

**Invalid States:**
- `PREPARING` - Cutover not yet started
- `READY_FOR_CUTOVER` - Not yet in progress
- `COMPLETED` - Cutover already completed
- `ROLLED_BACK` - Already rolled back
- `FAILED` - Already failed

## Usage

### Basic Rollback

```typescript
import { RollbackOrchestrator } from '@openmig/core';

const orchestrator = new RollbackOrchestrator(deps);

// Validate rollback is possible
const validation = await orchestrator.validateRollback(tenantId, mappingId);
if (!validation.canRollback) {
  console.error('Cannot rollback:', validation.reasons);
  return;
}

// Execute rollback
const result = await orchestrator.executeRollback(
  tenantId,
  mappingId,
  'User requested rollback due to issues'
);

console.log('Rollback successful:', result.success);
console.log('Steps completed:', result.completedSteps, '/', result.totalSteps);
```

### Custom Configuration

```typescript
const config: Partial<RollbackConfig> = {
  rollbackDns: true,
  restoreData: true,
  updateState: true,
  notifyUsers: false,  // Disable notifications
  preserveLogs: true,
  timeoutMinutes: 120, // 2 hours
};

const orchestrator = new RollbackOrchestrator(deps, config);
```

## Rollback Result

The rollback result provides detailed information about the rollback process:

```typescript
interface RollbackResult {
  success: boolean;                    // Overall success
  steps: RollbackStepResult[];         // Individual step results
  totalSteps: number;                  // Total number of steps
  completedSteps: number;              // Successfully completed steps
  failedSteps: string[];               // Failed step names
  warnings: string[];                  // Warnings during rollback
  rolledBackAt?: string;               // Timestamp
}
```

### Step Result

```typescript
interface RollbackStepResult {
  step: string;           // Step name
  success: boolean;       // Step success
  message: string;        // Step result message
  details?: object;       // Additional details
  error?: string;         // Error if failed
}
```

## Rollback Scenarios

### Scenario 1: Complete Success

All rollback steps complete successfully:

```
Rollback Result:
- Success: true
- Total Steps: 5
- Completed Steps: 5
- Failed Steps: []
- Warnings: []
```

### Scenario 2: Partial Failure

Some steps fail but others succeed:

```
Rollback Result:
- Success: false
- Total Steps: 5
- Completed Steps: 4
- Failed Steps: ['ROLLBACK_DNS']
- Warnings: ['ROLLBACK_DNS failed: DNS provider unavailable']
```

The orchestrator continues with remaining steps even when one fails, ensuring maximum recovery.

### Scenario 3: Timeout

Rollback exceeds the configured timeout:

```
Rollback Result:
- Success: false
- Total Steps: 5
- Completed Steps: 2
- Failed Steps: ['RESTORE_DATA', 'UPDATE_STATE', 'PRESERVE_LOGS']
- Warnings: ['Rollback exceeded 60 minutes']
```

## Dependencies

The rollback orchestrator requires the following dependencies:

```typescript
interface RollbackOrchestratorDeps {
  // Cutover state management
  getCutoverStatus(tenantId, mappingId): Promise<CutoverStatus>
  updateCutoverStatus(status: CutoverStatus): Promise<void>
  
  // DNS management
  getDnsStatus(tenantId, mappingId): Promise<DnsMigrationStatus>
  updateDnsStatus(status: DnsMigrationStatus): Promise<void>
  rollbackDns(tenantId, mappingId, previousRecords): Promise<{success, message}>
  
  // Data restoration
  getBackupMetadata(tenantId, mappingId, backupId): Promise<unknown>
  restoreData(tenantId, mappingId, backupId): Promise<{success, itemsRestored}>
  
  // Event logging
  logRollbackEvent(tenantId, mappingId, event, details): Promise<void>
  
  // Notifications
  sendNotification(tenantId, recipients, subject, body): Promise<void>
}
```

## Safety Considerations

### Non-Destructive by Default

Rollback operations are designed to be safe:
- Never deletes data permanently
- Preserves all logs and audit trails
- Allows manual intervention at each step

### Idempotency

Rollback can be safely retried:
- Failed steps can be re-executed
- State transitions are validated
- No duplicate side effects

### Audit Trail

All rollback actions are logged:
- Step execution status
- Errors and warnings
- Timing information
- User notifications

## Testing

The rollback orchestrator includes comprehensive unit tests:

**Test Coverage:**
- State validation (6 tests)
- Complete rollback execution (6 tests)
- Configuration handling (2 tests)

**Key Test Scenarios:**
- Rollback from valid states
- Rollback rejection from invalid states
- DNS rollback failure handling
- Data restoration
- Timeout handling
- Partial failure scenarios

## Future Enhancements

Planned improvements:
1. **Progress tracking**: Real-time rollback progress updates
2. **Selective rollback**: Choose specific components to rollback
3. **Rollback preview**: Simulate rollback before execution
4. **Automated recovery**: Self-healing for common rollback failures
5. **Rollback scheduling**: Delayed rollback execution

## Related Documentation

- [Cutover State Machine](./cutover.md)
- [DNS Management](./dns-management.md)
- [Verification](./verification.md)
- [Workplan 0004](./workplans/0004-cutover-dns.md)
