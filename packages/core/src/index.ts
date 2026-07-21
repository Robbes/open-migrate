// T1 contracts live in @openmig/shared (see ports.ts); implement impls here per docs/workplans/0001-first-slice-jmap-mail.md.
export const packageName = '@openmig/core';

export * from './reconcile';
export * from './reindex';
export * from './cutover-state';
export * from './verification';
export * from './verification-implementations';
export * from './cutover';
export * from './dns-manager';
export * from './dns-verify-only';
export * from './dns-provider-desec';
export * from './domain-sync';
export * from './dav-sync';
export * from './discovery';
