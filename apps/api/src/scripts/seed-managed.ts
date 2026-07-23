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
 * The demo tenants point at REAL backends so a shadow pass can actually
 * complete (not just fail at "no credentials"), provisioned by
 * `deploy/compose/setup-managed-demo.sh` before running this seed:
 *   - Tenant A: mail only, against the demo Stalwart (IMAP source, JMAP
 *     target) — the same fixed `source`/`target` accounts
 *     `deploy/selfhost/setup-stalwart.sh` always provisions.
 *   - Tenant B: calendar/contact/file only, against the demo Nextcloud
 *     (CalDAV/CardDAV/WebDAV) — two accounts setup-managed-demo.sh creates.
 * They're split this way (not all four domains on both tenants) because the
 * `connection` table has exactly one source + one target row per tenant,
 * shared by every domain — there's no way for one tenant's single
 * source/target pair to point at two unrelated backends (Stalwart AND
 * Nextcloud) at once with today's schema. Real tenants configure their own
 * connections through the API; this split is a demo-seed constraint only.
 *
 * Idempotent: fixed UUIDs + `ON CONFLICT DO NOTHING`, so re-running is a no-op
 * for everything except credentials — re-run after rotating a demo password
 * and the old encrypted secretRef sticks (ON CONFLICT DO NOTHING won't update
 * it); drop the connection row first if you need to rotate.
 * All writes go through `withTenant()` (transaction-scoped `app.current_tenant`),
 * so the script is correct whether it connects as the DB owner or as `app_user`.
 *
 * Usage (from repo root, with the managed stack + demo backend up — see
 * deploy/compose/setup-managed-demo.sh — and Postgres port exposed):
 *   DATABASE_URL=postgres://openmigrate:...@localhost:5432/openmigrate \
 *   JWT_SECRET=change-this-in-production \
 *   SECRET_ENCRYPTION_KEY=<32-byte key, same as the api/worker containers> \
 *   pnpm --filter @openmig/api seed:managed
 *
 * SECURITY: this is a *demo* seed against a throwaway local backend. The
 * printed JWTs and the hardcoded demo passwords below are for local
 * evaluation only; never run it against a production database.
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
import { SecretStore } from '@openmig/core/secret-store';

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
  /** Domains this tenant's single source/target pair can actually serve (see file header). */
  readonly domains: readonly ('email' | 'calendar' | 'contact' | 'file')[];
  readonly source: { readonly kind: 'imap' | 'nextcloud'; readonly config: Record<string, unknown>; readonly credentials: Record<string, string> };
  readonly target: { readonly kind: 'jmap' | 'nextcloud'; readonly config: Record<string, unknown>; readonly credentials: Record<string, string> };
}

// Demo Stalwart accounts (deploy/selfhost/setup-stalwart.sh always provisions these four,
// fixed, regardless of caller — see that script's PLAN_FILE). Reached by the compose
// network alias "stalwart" that setup-managed-demo.sh joins it to.
const STALWART_MAIL = { host: 'stalwart', imapsPort: 993, jmapBaseUrl: 'http://stalwart:8080' };

// Demo Nextcloud accounts (provisioned by setup-managed-demo.sh via the canonical
// deploy/selfhost/setup-nextcloud-users.sh, run once per tenant with tenant-specific
// usernames). Reached by the compose service name "nextcloud".
const NEXTCLOUD_DAV_BASE_URL = 'http://nextcloud/';

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
    domains: ['email'],
    source: {
      kind: 'imap',
      config: { type: 'imap-oauth2', host: STALWART_MAIL.host, port: STALWART_MAIL.imapsPort, user: 'source@dev.local' },
      credentials: { password: 'source_password' },
    },
    target: {
      kind: 'jmap',
      config: { type: 'jmap', baseUrl: STALWART_MAIL.jmapBaseUrl, user: 'target@dev.local' },
      credentials: { password: 'target_password' },
    },
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
    domains: ['calendar', 'contact', 'file'],
    source: {
      kind: 'nextcloud',
      config: { baseUrl: NEXTCLOUD_DAV_BASE_URL },
      credentials: { username: 'tenant-b-source', password: 'tenant_b_source_pw' },
    },
    target: {
      kind: 'nextcloud',
      config: { baseUrl: NEXTCLOUD_DAV_BASE_URL },
      credentials: { username: 'tenant-b-target', password: 'tenant_b_target_pw' },
    },
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

      // Source + target connections against the real demo backend (see file header for
      // why each tenant only points at one). Credentials are encrypted with the same
      // SECRET_ENCRYPTION_KEY the api/worker containers use, exactly like the real
      // create-mapping API route (apps/api/src/routes/migrations/index.ts).
      await tx
        .insert(connection)
        .values([
          {
            id: t.sourceConnectionId,
            tenantId: t.tenantId,
            role: 'source',
            kind: t.source.kind,
            displayName: `${t.source.kind} (demo source)`,
            config: t.source.config,
            secretRef: JSON.stringify(SecretStore.encryptCredentials(t.source.credentials).encrypted),
          },
          {
            id: t.targetConnectionId,
            tenantId: t.tenantId,
            role: 'target',
            kind: t.target.kind,
            displayName: `${t.target.kind} (demo target)`,
            config: t.target.config,
            secretRef: JSON.stringify(SecretStore.encryptCredentials(t.target.credentials).encrypted),
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

      // Scope selection: only the domains this tenant's backend can actually serve
      // (see the DemoTenant.domains comment) so managed-scheduler.ts has real work to do.
      await tx
        .insert(scopeSelection)
        .values(
          t.domains.map((domain) => ({
            mappingId: t.mappingId,
            tenantId: t.tenantId,
            domain,
            included: true,
            filters: {},
          })),
        )
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
  // Fails fast with a clear message via SecretStore.validate() -> validateSecretKey()
  // if SECRET_ENCRYPTION_KEY is missing/malformed, before any connection is encrypted.
  SecretStore.validate();

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
