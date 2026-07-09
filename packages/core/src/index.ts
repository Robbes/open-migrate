// T1 contracts live in @openmig/shared (see ports.ts); implement impls here per docs/workplans/0001-first-slice-jmap-mail.md.
export const packageName = '@openmig/core';

export * from './reconcile';
export * from './reindex';
export * from './cutover-state';
export * from './verification';
export * from './cutover';
export * from './unified-sync';
// GenericSyncEngine is pending implementation - see docs/workplans/0007-multi-domain-sync-completion.md
