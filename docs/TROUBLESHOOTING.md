# Troubleshooting Guide

This guide helps you diagnose and resolve common issues with Open Migration Stack.

## Table of Contents

1. [Installation & Setup](#installation--setup)
2. [Database Issues](#database-issues)
3. [API Problems](#api-problems)
4. [Web Application Issues](#web-application-issues)
5. [Migration Failures](#migration-failures)
6. [Billing & Payment Issues](#billing--payment-issues)
7. [Performance Issues](#performance-issues)
8. [Docker & Container Issues](#docker--container-issues)

---

## Installation & Setup

### Issue: `pnpm install` fails

**Symptoms:**
```
ERROR: Cannot find module 'pnpm'
```

**Solution:**
```bash
# Install pnpm globally
npm install -g pnpm

# Or use corepack
corepack enable
corepack prepare pnpm@latest --activate
```

### Issue: Environment variables not loaded

**Symptoms:**
```
Error: DATABASE_URL is required
```

**Solution:**
```bash
# Copy example environment file
cp .env.example .env

# Edit .env and fill in required values
nano .env

# Verify variables are loaded
cat .env
```

---

## Database Issues

### Issue: PostgreSQL connection refused

**Symptoms:**
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Solution:**
```bash
# Check if PostgreSQL is running
docker compose ps postgres

# If not running, start it
docker compose up -d postgres

# Check PostgreSQL logs
docker compose logs postgres

# Verify connection string
echo $DATABASE_URL
```

### Issue: RLS policies not working

**Symptoms:**
```
ERROR: permission denied for table mappings
```

**Solution:**
```sql
-- Enable RLS on table
ALTER TABLE mappings ENABLE ROW LEVEL SECURITY;

-- Verify policies exist
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
FROM pg_policies
WHERE tablename = 'mappings';

-- Re-run migration script if policies are missing
psql -U openmigrate -d openmigrate -f packages/ledger/migrations/enable-rls.sql
```

### Issue: Database migration fails

**Symptoms:**
```
ERROR: relation "mappings" already exists
```

**Solution:**
```bash
# Use idempotent migration
node packages/ledger/migrate-v2.js

# Or check current migrations
psql -U openmigrate -d openmigrate -c "SELECT * FROM _prisma_migrations;"
```

---

## API Problems

### Issue: API server won't start

**Symptoms:**
```
Error: PORT 3001 is already in use
```

**Solution:**
```bash
# Find process using the port
lsof -i :3001

# Kill the process
kill -9 <PID>

# Or change the port
export API_PORT=3002
```

### Issue: JWT authentication fails

**Symptoms:**
```
Error: Invalid token
```

**Solution:**
```bash
# Verify JWT_SECRET is set
echo $JWT_SECRET

# Regenerate token if needed
# Check token expiration
# Token should be valid for 24h by default
```

### Issue: CORS errors in browser

**Symptoms:**
```
Access to fetch at 'http://localhost:3001/api/...' from origin 'http://localhost:3123' has been blocked by CORS policy
```

**Solution:**
```bash
# Set CORS_ORIGIN environment variable
export CORS_ORIGIN=http://localhost:3123

# Or allow all origins (development only)
export CORS_ORIGIN=*
```

---

## Web Application Issues

### Issue: Web app won't load

**Symptoms:**
```
White screen, nothing loads
```

**Solution:**
```bash
# Check browser console for errors
# Press F12 and check Console tab

# Verify API is accessible
curl http://localhost:3001/health

# Rebuild the web app
cd apps/web
pnpm install
pnpm build
pnpm dev
```

### Issue: Login not working

**Symptoms:**
```
Login button does nothing or shows error
```

**Solution:**
```bash
# Check API logs
docker compose logs api

# Verify JWT_SECRET matches between API and web
# Check network tab in browser for failed requests
```

### Issue: Migration wizard stuck

**Symptoms:**
```
Wizard doesn't advance to next step
```

**Solution:**
```bash
# Check browser console for errors
# Verify all required fields are filled
# Check API logs for validation errors
# Clear browser cache and try again
```

---

## Migration Failures

### Issue: IMAP connection fails

**Symptoms:**
```
Error: IMAP connection failed: Authentication failed
```

**Solution:**
1. Verify IMAP credentials are correct
2. Check if IMAP is enabled on the source account
3. For Gmail, use an app password instead of regular password
4. Verify the IMAP server address and port
5. Check firewall rules allowing outbound connections

### Issue: JMAP target unreachable

**Symptoms:**
```
Error: JMAP endpoint not reachable
```

**Solution:**
```bash
# Test JMAP endpoint manually
curl -X POST https://jmap.example.com/jmap/ \
  -H "Content-Type: application/json" \
  -d '{"methodCalls": [["getAccount", {"accountId": "main"}]]}'

# Verify JMAP server is running
# Check network connectivity
# Verify authentication credentials
```

### Issue: Migration runs out of memory

**Symptoms:**
```
FATAL: out of memory
```

**Solution:**
```bash
# Increase Node.js memory limit
export NODE_OPTIONS="--max-old-space-size=4096"

# Reduce batch size in migration config
# Process in smaller chunks
# Add delays between batches
```

### Issue: Delta sync not detecting changes

**Symptoms:**
```
Delta sync finds no changes but there are new emails
```

**Solution:**
1. Verify UIDVALIDITY hasn't changed on the source
2. Check if source server supports MODSEQ
3. Try a full sync to reset state
4. Check server logs for IMAP errors

---

## Billing & Payment Issues

### Issue: Mollie payment creation fails

**Symptoms:**
```
Error: MOLLIE_API_KEY not configured
```

**Solution:**
```bash
# Set Mollie API key
export MOLLIE_API_KEY=live_xxxxxx

# For testing, use test key
export MOLLIE_API_KEY=test_xxxxxx

# Verify key is valid
curl https://api.mollie.com/v2/payments \
  -H "Authorization: Bearer $MOLLIE_API_KEY"
```

### Issue: Invoice not generating

**Symptoms:**
```
No invoices appear in billing page
```

**Solution:**
```bash
# Check if usage data exists
curl http://localhost:3001/api/billing/usage

# Manually trigger invoice generation
# Check billing service logs
docker compose logs api | grep billing
```

### Issue: Webhook not received from Mollie

**Symptoms:**
```
Payment status not updating
```

**Solution:**
```bash
# Verify webhook URL is accessible
curl https://yourdomain.com/api/billing/webhooks/mollie

# Check Mollie dashboard for webhook delivery status
# Verify webhook secret matches
# Check server logs for webhook requests
```

---

## Performance Issues

### Issue: API responds slowly

**Symptoms:**
```
Requests take > 5 seconds
```

**Solution:**
```bash
# Check database performance
psql -U openmigrate -d openmigrate -c "SELECT * FROM pg_stat_activity;"

# Enable query logging
export LOG_QUERIES=true

# Check for missing indexes
# Review slow query log

# Increase Node.js cluster workers
export NODE_CLUSTER_SIZE=4
```

### Issue: Database connections exhausted

**Symptoms:**
```
ERROR: too many connections for role
```

**Solution:**
```sql
-- Check active connections
SELECT count(*) FROM pg_stat_activity;

-- Increase max connections
ALTER SYSTEM SET max_connections = 200;
SELECT pg_reload_conf();

-- Kill idle connections
SELECT pg_terminate_backend(pid) 
FROM pg_stat_activity 
WHERE state = 'idle' AND query_start < now() - interval '5 minutes';
```

### Issue: High memory usage

**Symptoms:**
```
Container uses > 80% memory
```

**Solution:**
```bash
# Monitor memory usage
docker stats

# Restart containers to clear memory
docker compose restart

# Increase container memory limit
# Update deploy/compose/managed.yml
mem_limit: 4g
```

---

## Docker & Container Issues

### Issue: Containers won't start

**Symptoms:**
```
Error: Cannot start service api: driver failed programming external connector
```

**Solution:**
```bash
# Check for port conflicts
netstat -tulpn | grep LISTEN

# Remove stale containers
docker compose down -v

# Rebuild images
docker compose build --no-cache

# Start fresh
docker compose up -d
```

### Issue: Volume permissions error

**Symptoms:**
```
Error: permission denied for directory
```

**Solution:**
```bash
# Fix volume permissions
sudo chown -R 999:999 /path/to/volumes

# Or run containers as root (not recommended)
docker compose up -d
```

### Issue: Container keeps restarting

**Symptoms:**
```
Container status shows "Restarting"
```

**Solution:**
```bash
# Check container logs
docker compose logs -f api

# Common causes:
# - Missing environment variables
# - Database connection failed
# - Port already in use
# - Application crash

# Run container in foreground to debug
docker compose run --rm api
```

---

## Getting Help

If you can't resolve your issue using this guide:

1. **Check the logs:**
   ```bash
   docker compose logs -f
   ```

2. **Search GitHub Issues:**
   https://github.com/Robbes/open-migrate/issues

3. **Open a new issue:**
   - Include error messages
   - Provide your configuration
   - Describe steps to reproduce

4. **Community support:**
   - GitHub Discussions
   - Discord server

---

## Emergency Procedures

### Database Recovery

```bash
# Stop all services
docker compose down

# Restore from backup
gunzip < backup_20240101.sql.gz | psql -U openmigrate -d openmigrate

# Start services
docker compose up -d
```

### Reset Everything

```bash
# Warning: This deletes all data!
docker compose down -v
docker system prune -a

# Rebuild from scratch
git pull
docker compose build
docker compose up -d
```

---

*Last updated: 2024-01-15*
