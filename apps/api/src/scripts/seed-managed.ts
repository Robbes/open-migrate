// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Managed-edition demo seed (workplan 0011 T7).
 *
 * Seeds two demo tenants — each with an owner member and a source/target
 * connection + mailbox + mapping — so an operator can sign in as either tenant
 * and click through the Definition-of-Done journey against the managed compose
 * stack. It also mints a demo JWT per tenant owner (signed with JWT_SECRET),
 * because there is no password-login endpoint yet (auth is bearer-token only).
 *
 * Idempotent: fixed UUIDs + `ON CONFLICT DO NOTHING`, so re-running is a no-op.
 * All writes go through `withTenant()` (transaction-scoped `app.current_tenant`),
 * so the script is correct whether it connects as the DB owner or as `app_user`.
 *
 * Usage (from repo root, with the managed stack up and Postgres port exposed):
 *   DATABASE_URL=postgres://openmigrate:...@localhost:5432/openmigrate \
 *   JWT_SECRET=change-this-in-production \
 *   pnpm --filter @openmig/api seed:managed
 *
 * SECURITY: this is a *demo* seed. The printed JWTs are for local evaluation
 * only; never run it against a production database.
 */

import jwt from 'jsonwebtoken';
import {
  createPgDb,
  withTenant,
  tenant,
  tenantMember,
  connection,
  mailbox,
  mailboxMapping,
  scopeSelection,
} from '@openmig/ledger';

/** One demo tenant's fixed identifiers (deterministic → idempotent re-runs). */
interface DemoTenant {
  readonly tenantId: string;
  readonly name: string;
  readonly owner: { readonly userId: string; readonly email: string };
  readonly sourceConnectionId: string;
  readonly targetConnectionId: string;
  readonly sourceMailboxId: string;
  readonly targetMailboxId: string;
  readonly mappingId: string;
}

const DEMO_TENANTS: readonly DemoTenant[] = [
  {
    tenantId: 'a0000000-0000-4000-8000-000000000001',
    name: 'Demo Tenant A — Acme Families',
    owner: { userId: 'demo-owner-a', email: 'owner-a@demo.openmigrate.test' },
    sourceConnectionId: 'a0000000-0000-4000-8000-0000000000c1',
    targetConnectionId: 'a0000000-0000-4000-8000-0000000000c2',
    sourceMailboxId: 'a0000000-0000-4000-8000-0000000000b1',
    targetMailboxId: 'a0000000-0000-4000-8000-0000000000b2',
    mappingId: 'a0000000-0000-4000-8000-0000000000d1',
  },
  {
    tenantId: 'b0000000-0000-4000-8000-000000000002',
    name: 'Demo Tenant B — Bakerloo SMB',
    owner: { userId: 'demo-owner-b', email: 'owner-b@demo.openmigrate.test' },
    sourceConnectionId: 'b0000000-0000-4000-8000-0000000000c1',
    targetConnectionId: 'b0000000-0000-4000-8000-0000000000c2',
    sourceMailboxId: 'b0000000-0000-4000-8000-0000000000b1',
    targetMailboxId: 'b0000000-0000-4000-8000-0000000000b2',
    mappingId: 'b0000000-0000-4000-8000-0000000000d1',
  },
];

async function seedTenant(
  connectionString: string,
  jwtSecret: string,
  t: DemoTenant,
): Promise<string> {
  const db = createPgDb(connectionString);
  try {
    await withTenant(db.$pool, t.tenantId, async (tx) => {
      // Root entity first — RLS insert policy requires id === app.current_tenant.
      await tx.insert(tenant).values({ id: t.tenantId, name: t.name }).onConflictDoNothing();

      await tx
        .insert(tenantMember)
        .values({
          tenantId: t.tenantId,
          userId: t.owner.userId,
          email: t.owner.email,
          role: 'owner',
          status: 'active',
          joinedAt: new Date(),
        })
        .onConflictDoNothing();

      // Source (O365) + target (Nextcloud) connections. Config is illustrative;
      // real credentials are supplied out-of-band (never seeded).
      await tx
        .insert(connection)
        .values([
          {
            id: t.sourceConnectionId,
            tenantId: t.tenantId,
            role: 'source',
            kind: 'o365',
            displayName: 'O365 (demo source)',
            config: { host: 'outlook.office365.com', port: 993 },
          },
          {
            id: t.targetConnectionId,
            tenantId: t.tenantId,
            role: 'target',
            kind: 'nextcloud',
            displayName: 'Nextcloud (demo target)',
            config: { baseUrl: 'https://nextcloud.demo.openmigrate.test' },
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(mailbox)
        .values([
          {
            id: t.sourceMailboxId,
            tenantId: t.tenantId,
            connectionId: t.sourceConnectionId,
            externalId: 'source-primary',
            kind: 'user',
            primaryAddress: t.owner.email,
            displayName: 'Demo source mailbox',
          },
          {
            id: t.targetMailboxId,
            tenantId: t.tenantId,
            connectionId: t.targetConnectionId,
            externalId: 'target-primary',
            kind: 'user',
            primaryAddress: t.owner.email,
            displayName: 'Demo target mailbox',
          },
        ])
        .onConflictDoNothing();

      await tx
        .insert(mailboxMapping)
        .values({
          id: t.mappingId,
          tenantId: t.tenantId,
          sourceMailboxId: t.sourceMailboxId,
          targetMailboxId: t.targetMailboxId,
          mode: 'mirror',
          status: 'active',
        })
        .onConflictDoNothing();

      // Scope selection: enable all four domains for the demo tenants so the
      // managed-scheduler has work to do (email, calendar, contact, file).
      await tx
        .insert(scopeSelection)
        .values([
          { mappingId: t.mappingId, tenantId: t.tenantId, domain: 'email', included: true, filters: {} },
          { mappingId: t.mappingId, tenantId: t.tenantId, domain: 'calendar', included: true, filters: {} },
          { mappingId: t.mappingId, tenantId: t.tenantId, domain: 'contact', included: true, filters: {} },
          { mappingId: t.mappingId, tenantId: t.tenantId, domain: 'file', included: true, filters: {} },
        ])
        .onConflictDoNothing();
    });
  } finally {
    await db.close();
  }

  // Demo bearer token so the operator can call the API / paste into the web app.
  return jwt.sign(
    { sub: t.owner.userId, email: t.owner.email, tenantId: t.tenantId, role: 'owner' },
    jwtSecret,
    { expiresIn: '7d' },
  );
}

async function main(): Promise<void> {
  // Seed as the DB owner (bypasses RLS) — but withTenant makes app_user work too.
  const connectionString = process.env.DATABASE_URL ?? process.env.SEED_DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL (DB owner connection) is required to seed');
  }
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required to mint demo tokens (must match the API)');
  }

  const tokens: Array<{ tenant: string; email: string; token: string }> = [];
  for (const t of DEMO_TENANTS) {
    const token = await seedTenant(connectionString, jwtSecret, t);
    tokens.push({ tenant: t.name, email: t.owner.email, token });
    console.log(`seeded: ${t.name} (${t.tenantId})`);
  }

  console.log('\nDemo owner tokens (Authorization: Bearer <token>) — expire in 7 days:\n');
  for (const { tenant: name, email, token } of tokens) {
    console.log(`# ${name} — ${email}`);
    console.log(token);
    console.log('');
  }
  console.log('Seed complete. Re-running is a no-op (idempotent).');
}

main().catch((err) => {
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
