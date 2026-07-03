// T1 contracts live in @openmig/shared (see ports.ts); implement impls per docs/workplans/0001-first-slice-jmap-mail.md.
export const packageName = '@openmig/connectors';

export * from './imap-source';
export * from './jmap-target';
