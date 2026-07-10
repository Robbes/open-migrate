/**
 * WebDAV Source Types
 * 
 * Type definitions for WebDAV file source connector.
 * Follows RFC 4918 (WebDAV) for PROPFIND and property handling.
 */

import type { HttpClient as _HttpClient, HttpRequestOptions as _HttpRequestOptions, HttpResponse as _HttpResponse } from './dav-http.types';

/**
 * Configuration for WebDAV source connector.
 */
export interface WebDAVSourceConfig {
  /** WebDAV endpoint URL */
  url: string;
  /** Authentication username */
  username: string;
  /** Environment variable name containing the password */
  passwordEnv: string;
  /** Root path for file storage (optional) */
  rootPath?: string;
}

/**
 * WebDAV file metadata.
 */
export interface WebDAVFile {
  /** Full path to the file (natural key) */
  path: string;
  /** File name (last segment of path) */
  name: string;
  /** Whether this is a directory */
  isDirectory: false;
  /** File size in bytes */
  size: number;
  /** Last modified time (ISO 8601) */
  modifiedAt: string;
  /** Created time (ISO 8601), if available */
  createdAt?: string;
  /** ETag for change detection */
  etag: string;
  /** MIME type */
  mimeType?: string;
  /** Content type from WebDAV */
  contentType?: string;
  /** Resource type (collection or resource) */
  resourceType: 'file' | 'collection';
  /** Quota used (if available) */
  quotaUsed?: number;
  /** Quota available (if available) */
  quotaAvailable?: number;
}

/**
 * WebDAV folder metadata.
 */
export interface WebDAVFolder {
  /** Folder path */
  path: string;
  /** Human-readable name */
  name: string;
  /** Whether this is a directory */
  isDirectory: true;
  /** Folder description */
  description?: string;
  /** Quota information */
  quota?: {
    used: number;
    available?: number;
  };
  /** Creation time */
  createdAt?: string;
  /** Last modified time */
  modifiedAt?: string;
}

/**
 * Parsed PROPFIND response entry.
 */
export interface PropfindResponseEntry {
  /** HREF (path) of the resource */
  href: string;
  /** Status of the resource */
  status: string;
  /** Display name */
  displayName?: string;
  /** Resource type */
  resourceType?: ('collection' | 'resource')[];
  /** Get content type */
  getContentType?: string;
  /** Get content length */
  getContentLength?: number;
  /** Get last modified */
  getLastModified?: string;
  /** Get created */
  getCreated?: string;
  /** Get etag */
  getEtag?: string;
  /** Quota used */
  quotaUsed?: number;
  /** Quota available */
  quotaAvailable?: number;
  /** Calendar description (for CalDAV) */
  calendarDescription?: string;
  /** Calendar color */
  color?: string;
}

/**
 * Parsed PROPFIND response.
 */
export interface PropfindResponse {
  /** List of response entries */
  responses: PropfindResponseEntry[];
}
