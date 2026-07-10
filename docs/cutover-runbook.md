# Cutover Runbook

This runbook provides step-by-step procedures for executing and managing migration cutovers.

## Overview

A cutover is the final phase of a migration where:
1. All data has been synchronized (shadow pass complete)
2. DNS records are switched to point to the new system
3. Users begin using the new mail server
4. A grace period is monitored for any issues

## Prerequisites

Before starting a cutover, ensure:
- ✅ Shadow migration has completed successfully
- ✅ Verification checks have passed (data completeness, integrity)
- ✅ DNS TTLs have been lowered (300 seconds recommended, 24h before)
- ✅ Stakeholders have been notified of the maintenance window
- ✅ Rollback plan has been reviewed and approved

## Cutover States

The cutover state machine follows this progression:

```
PREPARING → READY_FOR_CUTOVER → APPROVED → CUTOVER_IN_PROGRESS → COMPLETED
                                                                        ↓
                                                                    ROLLED_BACK
                                                                        ↓
                                                                    FAILED
```

- **PREPARING**: Initial state, pre-cutover checks in progress
- **READY_FOR_CUTOVER**: All checks passed, waiting for approval
- **APPROVED**: Manually approved for execution
- **CUTOVER_IN_PROGRESS**: DNS switching and final sync in progress
- **COMPLETED**: Cutover successful, grace period active
- **ROLLED_BACK**: Cutover reverted to previous state
- **FAILED**: Cutover failed, requires investigation

## Commands

### Start Cutover

Initialize a new cutover:

```bash
node --loader ts-node/esm apps/worker/src/cli/index.ts start-cutover \
  --tenant <tenant-id> \
  --mapping <mapping-id> \
  --domain example.com \
  --target mail.example.com
```

### Run Verification

Check DNS and data completeness:

```bash
node --loader ts-node/esm apps/worker/src/cli/index.ts verify \
  --tenant <tenant-id> \
  --mapping <mapping-id> \
  --domain example.com
```

### Approve Cutover

After verification passes, approve for execution:

```bash
node --loader ts-node/esm apps/worker/src/cli/index.ts approve \
  --tenant <tenant-id> \
  --mapping <mapping-id> \
  --domain example.com
```

### Execute Cutover

Perform the actual cutover:

```bash
node --loader ts-node/esm apps/worker/src/cli/index.ts execute \
  --tenant <tenant-id> \
  --mapping <mapping-id> \
  --domain example.com \
  --target mail.example.com
```

### Rollback Cutover

Revert if issues are detected:

```bash
node --loader ts-node/esm apps/worker/src/cli/index.ts rollback \
  --tenant <tenant-id> \
  --mapping <mapping-id> \
  --domain example.com
```

### Check Status

View current cutover state:

```bash
node --loader ts-node/esm apps/worker/src/cli/index.ts status \
  --tenant <tenant-id> \
  --mapping <mapping-id> \
  --domain example.com
```

## Pre-Cutover Checklist (24 hours before)

- [ ] Lower DNS TTL to 300 seconds for all relevant records
- [ ] Verify shadow migration is complete and up-to-date
- [ ] Run `verify` command and confirm all checks pass
- [ ] Notify end users of upcoming maintenance window
- [ ] Confirm rollback procedure is understood by team
- [ ] Ensure rollback DNS records are documented

## Cutover Execution (During Maintenance Window)

### Step 1: Final Verification

```bash
node --loader ts-node/esm apps/worker/src/cli/index.ts verify \
  --tenant <tenant-id> \
  --mapping <mapping-id> \
  --domain example.com
```

Expected output:
```
✓ MX Records - Verified
✓ SPF Record - Verified
✓ DMARC Record - Verified
✓ Autodiscover - Verified
```

### Step 2: Approve Cutover

```bash
node --loader ts-node/esm apps/worker/src/cli/index.ts approve \
  --tenant <tenant-id> \
  --mapping <mapping-id> \
  --domain example.com
```

### Step 3: Execute Cutover

```bash
node --loader ts-node/esm apps/worker/src/cli/index.ts execute \
  --tenant <tenant-id> \
  --mapping <mapping-id> \
  --domain example.com \
  --target mail.example.com
```

This will:
1. Transition to CUTOVER_IN_PROGRESS state
2. Update DNS MX records to point to new server
3. Wait for DNS propagation (up to 10 attempts, 30s intervals)
4. Transition to COMPLETED state on success

### Step 4: Monitor Propagation

Watch for DNS propagation:

```bash
# Manual check
dig MX example.com
dig TXT example.com
dig TXT _dmarc.example.com
```

### Step 5: Verify Mail Flow

Test mail delivery:

```bash
# Send test email to new server
# Verify receipt
# Send test email from new server
# Verify delivery
```

## Post-Cutover (Grace Period)

During the grace period (typically 24-48 hours):

- Monitor mail queues for delivery failures
- Watch for user complaints or support tickets
- Keep rollback procedure ready
- Gradually increase DNS TTL back to normal (after 48h)

### Grace Period End

After successful grace period:

1. Restore DNS TTLs to normal values (86400 seconds)
2. Document any issues encountered
3. Close migration ticket
4. Send completion notification to stakeholders

## Rollback Procedure

If issues are detected during cutover or grace period:

### Step 1: Assess Situation

```bash
node --loader ts-node/esm apps/worker/src/cli/index.ts status \
  --tenant <tenant-id> \
  --mapping <mapping-id> \
  --domain example.com
```

### Step 2: Execute Rollback

```bash
node --loader ts-node/esm apps/worker/src/cli/index.ts rollback \
  --tenant <tenant-id> \
  --mapping <mapping-id> \
  --domain example.com
```

This will:
1. Restore previous DNS records
2. Cancel any pending tasks
3. Update cutover state to ROLLED_BACK
4. Notify users (if configured)

### Step 3: Post-Rollback Verification

- Verify DNS has reverted to original values
- Confirm mail flow is working on original server
- Document root cause of failure
- Plan remediation and retry

## Troubleshooting

### DNS Propagation Failed

**Symptoms**: `execute` command fails with "DNS propagation timeout"

**Resolution**:
1. Check DNS records manually: `dig MX example.com`
2. Verify DNS provider API is working
3. Check network connectivity to DNS servers
4. Consider manual DNS update if API fails
5. Retry `execute` command or rollback if needed

### Verification Failed

**Symptoms**: `verify` command shows FAIL status

**Resolution**:
1. Review specific failed checks
2. Fix underlying issues (e.g., missing DNS records)
3. Re-run verification
4. Do not proceed until all critical checks pass

### Mail Delivery Issues Post-Cutover

**Symptoms**: Users report not receiving/sending mail

**Resolution**:
1. Check MX records are pointing to correct server
2. Verify SPF/DKIM records are correct
3. Check mail server logs for errors
4. If critical, execute rollback immediately

## Emergency Contacts

- **Migration Team Lead**: [Name] - [Phone]
- **DNS Administrator**: [Name] - [Phone]
- **On-Call Engineer**: [Phone]

## Related Documentation

- [Architecture Decision Record 0022](./adr/0022-stalwart-integration.md)
- [Solution Architecture](./architecture/solution-architecture.md) §11
- [Stalwart Integration Fix](./stalwart-integration-fix.md)
