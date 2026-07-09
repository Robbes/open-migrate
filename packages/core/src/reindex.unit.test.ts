import { describe, it, expect } from 'vitest';
import { asMappingId, asTenantId, type ReindexDeps } from '@openmig/shared';
import { reindexFromTarget } from './reindex';
import { runShadowPass } from './reconcile';
import { MemoryLedger, MemorySource, MemoryTarget } from './__testing__/memory';

describe('reindexFromTarget (lost-ledger recovery)', () => {
  it('adopts existing target items into an empty ledger; a later pass creates nothing', async () => {
    // Populate the target via a normal pass.
    const source = new MemorySource();
    source.add({ folderPath: 'INBOX', messageId: '<a@x>', rfc822: 'Subject: A\r\n\r\nhello' });
    source.add({ folderPath: 'INBOX', messageId: '<b@x>', rfc822: 'Subject: B\r\n\r\nworld' });
    const target = new MemoryTarget();
    const ledger = new MemoryLedger();
    const id = { tenantId: asTenantId('t1'), mappingId: asMappingId('m1') };
    await runShadowPass({ ...id, source, target, ledger });
    expect(target.size()).toBe(2);

    // Simulate a lost ledger, then reindex from the target.
    ledger.clear();
    const reindexDeps: ReindexDeps = { ...id, reindexer: target, ledger };
    const r = await reindexFromTarget(reindexDeps);
    expect(r).toMatchObject({ scanned: 2, adopted: 2, alreadyKnown: 0 });
    expect(ledger.size()).toBe(2);

    // A subsequent pass creates nothing (everything already adopted).
    const pass = await runShadowPass({ ...id, source, target, ledger });
    expect(pass.created).toBe(0);

    // Reindexing again is a no-op.
    const r2 = await reindexFromTarget(reindexDeps);
    expect(r2).toMatchObject({ adopted: 0, alreadyKnown: 2 });
  });
});
