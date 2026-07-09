export const packageName = '@openmig/engines';

export {
  runImapsyncBulk,
  checkImapsyncAvailable,
  getImapsyncVersion,
  type BulkSyncResult,
  type ImapSyncConfig,
} from './imapsync-wrapper';

export {
  runCalDAVSync,
  cleanupCalDAVConfig,
  type CalDAVSyncConfig,
  type CalDAVSyncResult,
} from './caldav-sync';

export {
  runCardDAVSync,
  cleanupCardDAVConfig,
  type CardDAVSyncConfig,
  type CardDAVSyncResult,
} from './carddav-sync';

export {
  runWebDAVSync,
  cleanupWebDAVConfig,
  type WebDAVSyncConfig,
  type WebDAVSyncResult,
} from './webdav-sync';
