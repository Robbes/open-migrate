# Open Migration API

REST API for the Open Migration Stack managed edition.

## Overview

The API provides endpoints for:
- **Tenant Management**: Create, update, delete tenants and manage members
- **Migration Control**: Configure and trigger migrations, monitor progress
- **Billing**: Track usage, manage payments (coming soon)
- **Webhooks**: Receive job status updates from Trigger.dev

## Quick Start

### Prerequisites

- Node.js 24+
- PostgreSQL 15+ (with RLS enabled)
- Trigger.dev (Cloud or self-hosted)

### Installation

1. **Install dependencies:**
```bash
pnpm install
```

2. **Configure environment:**
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. **Run database migrations:**
```bash
pnpm migrate
```

4. **Start the API server:**
```bash
pnpm dev
```

The API will be available at `http://localhost:3001`

## Environment Variables

```bash
# Server
NODE_ENV=development|production
API_PORT=3001
CORS_ORIGIN=http://localhost:3000

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/openmigrate

# Authentication
JWT_SECRET=your-secret-key (for self-hosted)
JWT_ISSUER=https://auth.example.com (for managed auth)

# Trigger.dev
TRIGGER_DEV_API_KEY=your_api_key
TRIGGER_DEV_API_URL=https://app.trigger.dev
TRIGGER_WEBHOOK_SECRET=your_webhook_secret
```

## API Endpoints

### Health Check

```bash
curl http://localhost:3001/health
```

### Tenants

```bash
# List tenants
curl -H "Authorization: Bearer <token>" http://localhost:3001/api/tenants

# Create tenant
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Company","slug":"my-company"}' \
  http://localhost:3001/api/tenants
```

### Migrations

```bash
# List mappings
curl -H "Authorization: Bearer <token>" http://localhost:3001/api/mappings

# Create mapping
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"My Migration",
    "sourceType":"imap",
    "targetType":"jmap",
    "sourceConfig":{"host":"imap.example.com","port":993,"username":"user","useSsl":true},
    "targetConfig":{"host":"jmap.example.com","port":443,"username":"user","password":"pass","useSsl":true}
  }' \
  http://localhost:3001/api/mappings

# Trigger sync
curl -X POST -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"type":"full"}' \
  http://localhost:3001/api/mappings/{mappingId}/sync
```

### Webhooks

```bash
# Webhook endpoint (for Trigger.dev)
POST http://localhost:3001/api/webhooks/trigger
Headers: x-trigger-signature: <signature>
```

## Authentication

All API endpoints (except webhooks and health check) require JWT authentication.

### JWT Token Structure

```json
{
  "sub": "user-123",
  "email": "user@example.com",
  "tenantId": "tenant-123",
  "role": "owner|admin|member|viewer",
  "iat": 1640000000,
  "exp": 1640086400
}
```

### Token Issuance

**Self-hosted:** Use the JWT_SECRET to sign tokens with any JWT library.

**Managed:** Integrate with Auth0, Clerk, or similar identity providers.

## Tenant Isolation

The API enforces tenant isolation through:
1. **JWT Claims**: Token contains tenantId
2. **Middleware**: Verifies tenant context on each request
3. **RLS**: PostgreSQL Row-Level Security enforces isolation at database level

## Error Handling

All errors return JSON with this format:

```json
{
  "error": "Error Type",
  "message": "Human-readable message",
  "details": [...]
}
```

### Common Status Codes

- `200` - Success
- `201` - Created
- `204` - No Content
- `400` - Bad Request (validation error)
- `401` - Unauthorized (invalid/missing token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `500` - Internal Server Error

## Role-Based Access Control

| Endpoint | Owner | Admin | Member | Viewer |
|----------|-------|-------|--------|--------|
| List tenants | ✓ | ✓ | ✓ | ✓ |
| Create tenant | ✓ | ✓ | ✗ | ✗ |
| Update tenant | ✓ | ✓ | ✗ | ✗ |
| Delete tenant | ✓ | ✗ | ✗ | ✗ |
| Manage members | ✓ | ✓ | ✗ | ✗ |
| List mappings | ✓ | ✓ | ✓ | ✓ |
| Create mapping | ✓ | ✓ | ✓ | ✗ |
| Update mapping | ✓ | ✓ | ✓ | ✗ |
| Delete mapping | ✓ | ✓ | ✓ | ✗ |
| Trigger sync | ✓ | ✓ | ✓ | ✗ |
| Trigger cutover | ✓ | ✓ | ✗ | ✗ |

## Testing

```bash
# Run tests
pnpm test

# Run with coverage
pnpm test:coverage

# Run integration tests
pnpm test:integration
```

## API Documentation

Full API documentation is available at:
- [OpenAPI Spec](./docs/openapi.yaml)
- [Swagger UI](http://localhost:3001/api-docs) (when running locally)

## Development

### Project Structure

```
apps/api/
├── src/
│   ├── index.ts              # Express app setup
│   ├── middleware/
│   │   └── auth.ts          # JWT authentication
│   └── routes/
│       ├── trigger-webhook.ts
│       ├── tenants/
│       │   ├── index.ts     # Tenant CRUD
│       │   └── members.ts   # Member management
│       └── migrations/
│           └── index.ts     # Migration CRUD & control
├── docs/
│   └── openapi.yaml         # OpenAPI specification
└── package.json
```

### Debugging

```bash
# Enable debug logging
NODE_ENV=development DEBUG=* pnpm dev
```

## Production Deployment

### Docker

```bash
docker build -t openmigrate-api -f apps/api/Dockerfile .
docker run -d \
  -e DATABASE_URL=xxx \
  -e JWT_SECRET=xxx \
  -e TRIGGER_DEV_API_KEY=xxx \
  -p 3001:3001 \
  openmigrate-api
```

### Kubernetes

```bash
helm install api ./deploy/helm/api \
  --set database.url=xxx \
  --set jwt.secret=xxx
```

## Monitoring

### Health Check

```bash
curl http://localhost:3001/health
```

### Metrics

Coming soon - Prometheus metrics endpoint.

## Troubleshooting

### JWT Validation Fails

- Verify JWT_SECRET is set correctly
- Check token expiration (exp claim)
- Ensure token format is correct (Bearer <token>)

### Tenant Isolation Issues

- Verify RLS is enabled in database
- Check app.current_tenant is set correctly
- Review RLS policies

### Trigger.dev Webhook Issues

- Verify TRIGGER_WEBHOOK_SECRET matches Trigger.dev config
- Check firewall allows incoming webhooks
- Review webhook logs in Trigger.dev dashboard

## References

- [Workplan 0005](../../.agents_tmp/PLAN.md)
- [Architecture Decisions](../../docs/adr/)
- [Trigger.dev Docs](https://trigger.dev/docs)
- [PostgreSQL RLS](https://www.postgresql.org/docs/current/sql-altertable.html#SQL-ALTERTABLE-RLS)

---

*This API is part of the Open Migration Stack, an open-source project for sovereign email/data migration.*
