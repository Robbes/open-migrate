// Copyright 2026 OpenHands Agent (Apache-2.0)
// T1 contracts live in @openmig/shared (see ports.ts); implement impls per docs/workplans/0001-first-slice-jmap-mail.md.
export const packageName = '@openmig/connectors';

export * from './imap-source';
export * from './jmap-target';
export * from './imap-dav-target';

// DAV shared HTTP types
export * from './dav-http.types';

// CalDAV source connector
export * from './caldav-source';
export * from './caldav-source.types';

// CardDAV source connector
export * from './carddav-source';
export * from './carddav-source.types';

// WebDAV file source connector
export * from './webdav-source';
export * from './webdav-source.types';

// Token provider
export * from './token-provider';

// Graph Calendar source connector
export * from './graph-calendar-source';
export * from './graph-calendar-source.types';

// Graph Contacts source connector
export * from './graph-contacts-source';
export * from './graph-contacts-source.types';
