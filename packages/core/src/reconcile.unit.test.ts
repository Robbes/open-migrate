import { describe, it, expect } from 'vitest';
import { asMappingId, asTenantId, type ReconcileDeps } from '@openmig/shared';
import { runShadowPass } from './reconcile';
import { MemoryCursorStore, MemoryLedger, MemorySource, MemoryTarget } from './__testing__/memory';

function seededSource(): MemorySource {
  const s = new MemorySource();
  s.add({ folderPath: 'INBOX', messageId: '<a@x>', rfc822: 'Subject: A\r\n\r\nhello', keywords: ['$seen'] });
  s.add({ folderPath: 'INBOX', messageId: '<b@x>', rfc822: 'Subject: B\r\n\r\nworld' });
  s.add({ folderPath: 'Sent', messageId: '<c@x>', rfc822: 'Subject: C\r\n\r\nsent', keywords: ['$seen'] });
  return s;
}

function deps(source: MemorySource, target: MemoryTarget, ledger: MemoryLedger): ReconcileDeps {
  return { tenantId: asTenantId('t1'), mappingId: asMappingId('m1'), source, target, ledger };
}

describe('runShadowPass (idempotent one-way shadow)', () => {
  it('mirrors the source on the first pass and is a no-op on the second', async () => {
    const source = seededSource();
    const target = new MemoryTarget();
    const ledger = new MemoryLedger();

    const r1 = await runShadowPass(deps(source, target, ledger));
    expect(r1).toMatchObject({ scanned: 3, created: 3, skipped: 0 });
    expect(target.size()).toBe(3);

    const r2 = await runShadowPass(deps(source, target, ledger));
    expect(r2).toMatchObject({ scanned: 3, created: 0, skipped: 3 });
    expect(target.size()).toBe(3); // no duplicates
  });

  it('creates only the new message on a delta pass', async () => {
    const source = seededSource();
    const target = new MemoryTarget();
    const ledger = new MemoryLedger();
    await runShadowPass(deps(source, target, ledger));

    source.add({ folderPath: 'INBOX', messageId: '<d@x>', rfc822: 'Subject: D\r\n\r\nnew' });
    const r = await runShadowPass(deps(source, target, ledger));
    expect(r.created).toBe(1);
    expect(target.size()).toBe(4);
  });

  it('does not duplicate after the ledger is wiped (lost-ledger recovery)', async () => {
    const source = seededSource();
    const target = new MemoryTarget();
    const ledger = new MemoryLedger();
    await runShadowPass(deps(source, target, ledger));
    expect(target.size()).toBe(3);

    ledger.clear(); // simulate a fresh reinstall with an empty ledger
    const r = await runShadowPass(deps(source, target, ledger));
    expect(r.created).toBe(0); // create-if-absent on the target prevents duplicates
    expect(target.size()).toBe(3);
    expect(ledger.size()).toBe(3); // ledger re-adopted from the target
  });
});

describe('runShadowPass with incremental cursors', () => {
  it('lists only changed items on steady-state passes and persists cursors per folder', async () => {
    const source = seededSource();
    const target = new MemoryTarget();
    const ledger = new MemoryLedger();
    const cursors = new MemoryCursorStore();
    const d = { ...deps(source, target, ledger), cursors };

    const r1 = await runShadowPass(d);
    expect(r1).toMatchObject({ scanned: 3, created: 3 });

    // Steady state: cursor skips everything — nothing is even listed.
    const r2 = await runShadowPass(d);
    expect(r2).toMatchObject({ scanned: 0, created: 0 });

    // Delta: only the new message is listed and created.
    source.add({ folderPath: 'INBOX', messageId: '<d@x>', rfc822: 'Subject: D\r\n\r\nnew' });
    const r3 = await runShadowPass(d);
    expect(r3).toMatchObject({ scanned: 1, created: 1 });
    expect(target.size()).toBe(4);
  });

  it('a lost cursor store forces a full re-scan that stays idempotent', async () => {
    const source = seededSource();
    const target = new MemoryTarget();
    const ledger = new MemoryLedger();
    const cursors = new MemoryCursorStore();
    const d = { ...deps(source, target, ledger), cursors };
    await runShadowPass(d);

    cursors.clear(); // lost cursors -> full re-scan; ledger keeps it a no-op
    const r = await runShadowPass(d);
    expect(r).toMatchObject({ scanned: 3, created: 0, skipped: 3 });
    expect(target.size()).toBe(3);
  });
});
