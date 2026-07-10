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

// Target writers
export {
  CalDAVTargetWriter,
  type CalDAVTargetConfig,
} from './caldav-target-writer';

export {
  CardDAVTargetWriter,
  type CardDAVTargetConfig,
} from './carddav-target-writer';

export {
  WebDAVTargetWriter,
  type WebDAVTargetConfig,
} from './webdav-target-writer';
