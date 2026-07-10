import { defineConfig } from 'drizzle-kit';

// Canonical DDL is packages/ledger/migrations/0001_init.sql (source of truth, ADR-0016).
// The Drizzle table definitions in packages/ledger/src/schema-pg.ts mirror that DDL and
// are filled in during the ledger implementation slice.
export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/ledger/src/schema-pg.ts',
  out: './packages/ledger/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
