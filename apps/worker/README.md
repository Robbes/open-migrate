# Worker Application

The worker application handles background job execution using Trigger.dev for the managed edition.

## Overview

The worker is responsible for:
- Executing migration jobs (full sync, delta sync, cutover, rollback)
- Processing webhooks from Trigger.dev
- Managing background tasks with durable execution

## Architecture

```
apps/worker/
├── src/
│   ├── trigger-client.ts    # Trigger.dev client configuration
│   ├── jobs/                # Job definitions
│   │   ├── run-full-sync.ts
│   │   ├── run-delta-sync.ts
│   │   ├── run-cutover.ts
│   │   └── run-rollback.ts
│   └── index.ts             # Worker entry point
└── package.json
```

## Environment Variables

```bash
# Trigger.dev Configuration
TRIGGER_DEV_API_KEY=your_api_key
TRIGGER_DEV_API_URL=https://app.trigger.dev  # or http://localhost:3000
TRIGGER_ENVIRONMENT=production

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/openmigrate

# Webhook Security
TRIGGER_WEBHOOK_SECRET=your_webhook_secret
```

## Development

### Prerequisites

- Node.js 24+
- PostgreSQL 15+
- Trigger.dev (Cloud or self-hosted)

### Setup

1. **Install dependencies:**
```bash
pnpm install
```

2. **Configure environment:**
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. **Start Trigger.dev (self-hosted option):**
```bash
docker compose -f deploy/compose/trigger.yml up -d
```

4. **Run the worker:**
```bash
pnpm dev
```

### Running Jobs

Jobs are triggered automatically by:
- **Cron schedules** (full sync, delta sync)
- **Manual triggers** (cutover, rollback)
- **Events** (user actions via API)

### Manual Job Triggering

```typescript
import { getTriggerClient } from './src/trigger-client';

const client = getTriggerClient();

// Trigger a full sync
await client.trigger({
  job: 'run-full-sync',
  payload: {
    tenantId: 'uuid-here',
    mappingId: 'uuid-here',
    options: {
      forceFullScan: false,
    },
  },
});
```

## Job Definitions

### Full Sync (`run-full-sync`)

Executes a complete synchronization for a mapping.

**Trigger:** Daily at 2 AM (cron)

**Input:**
```typescript
{
  tenantId: string;
  mappingId: string;
  options: {
    forceFullScan: boolean;
    maxItems?: number;
  };
}
```

**Features:**
- Idempotent execution
- Full scan of all items
- Updates ledger with sync results

### Delta Sync (`run-delta-sync`)

Executes an incremental synchronization, processing only changes.

**Trigger:** Every 15 minutes (cron)

**Input:**
```typescript
{
  tenantId: string;
  mappingId: string;
  domains?: ('email' | 'calendar' | 'contact' | 'file')[];
}
```

**Features:**
- Uses checkpoints for efficiency
- Only processes changed items
- Minimal resource usage

### Cutover (`run-cutover`)

Executes the final cutover process.

**Trigger:** Manual (user-initiated)

**Input:**
```typescript
{
  tenantId: string;
  mappingId: string;
  options: {
    skipFinalSync: boolean;
    skipVerification: boolean;
    gracePeriodHours: number;
  };
}
```

**Process:**
1. Final delta sync
2. Verification checks
3. Update cutover status
4. Start grace period monitoring

### Rollback (`run-rollback`)

Rolls back a cutover if issues are detected.

**Trigger:** Manual or automatic on failure

**Input:**
```typescript
{
  tenantId: string;
  mappingId: string;
  reason?: string;
  options: {
    restoreDns: boolean;
    notifyUsers: boolean;
  };
}
```

**Process:**
1. Stop grace period monitoring
2. Restore DNS/MX records
3. Update cutover status
4. Notify users

## Monitoring

### Job Status

Job status is tracked in the `run` table:
```sql
SELECT * FROM run 
WHERE mapping_id = 'uuid-here' 
ORDER BY created_at DESC 
LIMIT 10;
```

### Logs

Job logs are stored in the `run_event` table:
```sql
SELECT * FROM run_event 
WHERE run_id = 'run-uuid' 
ORDER BY at ASC;
```

### Trigger.dev Dashboard

View job execution history, logs, and metrics in the Trigger.dev dashboard:
- Cloud: https://app.trigger.dev
- Self-hosted: http://localhost:3000

## Error Handling

### Automatic Retries

Jobs automatically retry with exponential backoff:
- Attempt 1: Immediate
- Attempt 2: 1 minute
- Attempt 3: 5 minutes
- Attempt 4: 15 minutes
- Attempt 5: 1 hour

### Failed Jobs

Jobs that fail after all retries are marked as `failed` in the `run` table. Operators should:
1. Check logs in Trigger.dev dashboard
2. Review `run_event` table for errors
3. Fix underlying issue
4. Manually re-trigger the job

## Security

### Webhook Verification

Webhooks from Trigger.dev are verified using HMAC-SHA256 signatures:

```typescript
const signature = req.headers['x-trigger-signature'];
const isValid = verifySignature(payload, signature, TRIGGER_WEBHOOK_SECRET);
```

### Tenant Isolation

All jobs respect RLS policies:
- Jobs can only access data for their tenant
- Tenant context is set from job payload
- Database enforces isolation

## Production Deployment

### Docker

```bash
docker build -t openmigrate-worker -f apps/worker/Dockerfile .
docker run -d \
  --name worker \
  -e TRIGGER_DEV_API_KEY=xxx \
  -e DATABASE_URL=xxx \
  openmigrate-worker
```

### Kubernetes

```bash
helm install worker ./deploy/helm/worker \
  --set trigger.apiKey=xxx \
  --set database.url=xxx
```

## Troubleshooting

### Jobs Not Running

1. Check Trigger.dev connection:
```bash
curl https://app.trigger.dev/api/health
```

2. Verify environment variables are set
3. Check worker logs for errors

### Webhook Issues

1. Verify webhook secret matches Trigger.dev configuration
2. Check firewall rules allow incoming webhooks
3. Review webhook logs in Trigger.dev dashboard

### Database Connection Errors

1. Verify `DATABASE_URL` is correct
2. Check database is running
3. Verify RLS is enabled:
```sql
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' 
LIMIT 5;
```

## References

- [Trigger.dev Documentation](https://trigger.dev/docs)
- [Workplan 0005](../../.agents_tmp/PLAN.md)
- [RLS Guide](../../docs/rls-guide.md)
- [Architecture Decision Records](../../docs/adr/)
