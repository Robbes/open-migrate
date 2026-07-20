// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Shared factories for the native DAV connectors (workplan 0010/0011 T3).
 *
 * One real implementation used by BOTH deps-builders — the managed DB path
 * (`build-deps-from-mapping.ts`) and the self-host file path (`build-deps.ts`) —
 * so both editions sync calendar/contact/file for real instead of one path
 * carrying placeholders. Callers resolve their own config/credentials (DB row +
 * decrypted secret, or file config + env) into a normalized endpoint and hand it
 * here.
 */

import { CalDAVSource, CarddavSource, WebdavFileSource } from '@openmig/connectors';
import { CalDAVTargetWriter, CardDAVTargetWriter, WebDAVTargetWriter } from '@openmig/engines';
import type {
  Ledger,
  TenantId,
  MappingId,
  CalendarSource,
  ContactSource,
  FileSource,
  CalendarTargetWriter,
  ContactTargetWriter,
  FileTargetWriter,
} from '@openmig/shared';

/** A resolved DAV endpoint: URL + direct credentials (never env-indirected here). */
export interface DavEndpoint {
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

/** Deps every DAV target writer needs. */
export interface DavTargetDeps {
  readonly ledger: Ledger;
  readonly tenantId: TenantId;
  readonly mappingId: MappingId;
}

export function buildCalendarSource(e: DavEndpoint): CalendarSource {
  return new CalDAVSource({ url: e.url, username: e.username, password: e.password });
}
export function buildCalendarTarget(e: DavEndpoint, d: DavTargetDeps): CalendarTargetWriter {
  return new CalDAVTargetWriter({ url: e.url, username: e.username, password: e.password }, d);
}

export function buildContactSource(e: DavEndpoint): ContactSource {
  return new CarddavSource({ url: e.url, username: e.username, password: e.password });
}
export function buildContactTarget(e: DavEndpoint, d: DavTargetDeps): ContactTargetWriter {
  return new CardDAVTargetWriter({ url: e.url, username: e.username, password: e.password }, d);
}

export function buildFileSource(e: DavEndpoint): FileSource {
  return new WebdavFileSource({ url: e.url, username: e.username, password: e.password });
}
export function buildFileTarget(e: DavEndpoint, d: DavTargetDeps): FileTargetWriter {
  return new WebDAVTargetWriter({ url: e.url, username: e.username, password: e.password }, d);
}
