/**
 * WebDAV Source Connector Implementation
 * 
 * Implements FileSource interface for WebDAV file synchronization.
 * Follows RFC 4918 (WebDAV) for PROPFIND and property handling.
 * 
 * Features:
 * - PROPFIND depth-1 walk for file enumeration
 * - ETag-based change detection
 * - Size and mtime as additional change indicators
 * - Normalized path as natural key (case-sensitive)
 * - Support for binary file content
 */

import type { FileSource, FileFolder, RawFileItem, SyncCursor } from '@openmig/shared';
import type { 
  WebDAVSourceConfig, 
  WebDAVFile, 
  WebDAVFolder, 
  PropfindResponseEntry,
  PropfindResponse,
} from './webdav-source.types';
import type { HttpClient, HttpRequestOptions, HttpResponse } from './dav-http.types';

/**
 * WebDAV source connector implementation.
 */
export class WebdavFileSource implements FileSource {
  private readonly config: WebDAVSourceConfig;
  private readonly httpClient: HttpClient;

  constructor(
    config: WebDAVSourceConfig,
    deps?: { httpClient?: HttpClient },
  ) {
    this.config = config;
    this.httpClient = deps?.httpClient ?? createDefaultHttpClient();
  }

  /**
   * Enumerate all file folders/directories.
   * Uses PROPFIND with Depth: 1 to discover collections.
   */
  async listFolders(): Promise<ReadonlyArray<FileFolder>> {
    // Start from root path
    const rootPath = this.config.rootPath || '/';
    
    // Perform PROPFIND to discover folders (config-derived path, use buildUrl)
    const response = await this.performPropfind(rootPath, '1', false);
    
    // Parse and filter for collections (directories)
    const folders: FileFolder[] = [];
    
    for (const entry of response.responses) {
      if (this.isCollection(entry)) {
        const folder = this.parseFolderFromEntry(entry);
        if (folder) {
          folders.push(folder);
        }
      }
    }
    
    return folders;
  }

  /**
   * List files changed since cursor (or all if undefined).
   * Uses PROPFIND with Depth: 1 to enumerate files in a folder.
   * 
   * Change detection strategy:
   * - ETag comparison (primary)
   * - Size comparison (secondary)
   * - mtime comparison (tertiary)
   */
  async listSince(
    folder: FileFolder,
    cursor?: SyncCursor,
  ): Promise<{ items: ReadonlyArray<RawFileItem>; nextCursor: SyncCursor }> {
    const folderPath = this.normalizePath(folder.path);
    
    // folder.path comes from server-returned href, use resolveHref (Rule A)
    const response = await this.performPropfind(folderPath, '1', true);
    
    // Parse entries and filter for files (not directories)
    const items: RawFileItem[] = [];
    let hasChanges = false;
    
    for (const entry of response.responses) {
      // Skip the folder itself (Depth: 1 returns the collection too)
      if (this.isCollection(entry)) {
        continue;
      }
      
      const file = this.parseFileFromEntry(entry);
      if (file) {
        // Check if file has changed since cursor (using basename as key)
        if (this.hasChanged(file, cursor)) {
          hasChanges = true;
          // Fetch file content using the full href (sourceRef)
          const sourceRef = this.resolveHref(entry.href);
          const content = await this.fetchFileContent(sourceRef);
          
          items.push({
            item: {
              ...file,
              sourceRef: entry.href,  // Keep full href for fetching
            },
            content,
          });
        }
      }
    }
    
    // Create next cursor from current state
    // For WebDAV, we use a simple cursor based on the latest ETag
    const nextCursor: SyncCursor = {
      value: this.buildCursor(folderPath, hasChanges ? items : []),
    };
    
    return { items, nextCursor };
  }

  /**
   * Fetch the raw content of a file.
   * The url should already be fully resolved (caller handles resolution).
   */
  async fetchFileContent(url: string): Promise<Uint8Array> {
    const response = await this.httpClient.request({
      method: 'GET',
      url,
      headers: {
        Authorization: this.getAuthorizationHeader(),
      },
    });
    
    if (response.status === 200 || response.status === 204) {
      // Convert string body to Uint8Array
      const encoder = new TextEncoder();
      return encoder.encode(response.body);
    }
    
    throw new Error(`Failed to fetch file content: ${response.status}`);
  }

  // Private helper methods

  /**
   * Perform a PROPFIND request to a WebDAV resource.
   * 
   * @param path - The path to the resource (can be config-derived or server-returned)
   * @param depth - The depth header value ('0', '1', or 'infinity')
   * @param useResolveHref - If true, treat path as server-returned href (Rule A).
   *                        If false, treat as config-derived path (Rule B).
   * @returns Parsed PROPFIND response
   */
  private async performPropfind(
    path: string, 
    depth: string,
    useResolveHref: boolean = false
  ): Promise<PropfindResponse> {
    const propfindXml = this.buildPropfindXml();
    
    // Use resolveHref for server-returned paths, buildUrl for config-derived
    const url = useResolveHref ? this.resolveHref(path) : this.buildUrl(path);
    
    const response = await this.httpClient.request({
      method: 'PROPFIND',
      url,
      body: propfindXml,
      headers: {
        'Content-Type': 'application/xml',
        Depth: depth,
        Authorization: this.getAuthorizationHeader(),
      },
    });
    
    if (response.status !== 207) {
      throw new Error(`PROPFIND failed with status ${response.status}: ${response.body}`);
    }
    
    return this.parsePropfindResponse(response.body);
  }

  /**
   * Build the PROPFIND XML request body.
   * Requests common properties for file metadata.
   */
  private buildPropfindXml(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
      <D:propfind xmlns:D="DAV:">
        <D:prop>
          <D:displayname/>
          <D:resourcetype/>
          <D:getcontentlength/>
          <D:getlastmodified/>
          <D:getetag/>
          <D:getcontenttype/>
          <D:creationdate/>
          <Q:quota-used-bytes xmlns:Q="DAV:"/>
          <Q:quota-available-bytes xmlns:Q="DAV:"/>
        </D:prop>
      </D:propfind>`;
  }

  /**
   * Parse a PROPFIND response XML into structured data.
   */
  private parsePropfindResponse(body: string): PropfindResponse {
    const responses: PropfindResponseEntry[] = [];
    
    // Parse each response element
    const responseRegex = /<D:response[^>]*>([\s\S]*?)<\/D:response>/gi;
    let match: RegExpExecArray | null;
    
    while ((match = responseRegex.exec(body)) !== null) {
      const responseContent = match[1];
      if (responseContent) {
        const entry = this.parsePropfindEntry(responseContent);
        if (entry) {
          responses.push(entry);
        }
      }
    }
    
    return { responses };
  }

  /**
   * Parse a single PROPFIND response entry.
   */
  private parsePropfindEntry(content: string): PropfindResponseEntry | null {
    // Extract href
    const hrefMatch = content.match(/<D:href[^>]*>([^<]+)<\/D:href>/i);
    if (!hrefMatch || !hrefMatch[1]) {
      return null;
    }
    
    const href = this.normalizePath(hrefMatch[1].trim());
    
    // Extract status
    const statusMatch = content.match(/<D:status[^>]*>([^<]+)<\/D:status>/i);
    const status = statusMatch?.[1]?.trim() ?? 'HTTP/1.1 200 OK';
    
    // Extract display name
    const displayNameMatch = content.match(/<D:displayname[^>]*>([^<]*)<\/D:displayname>/i);
    const displayName = displayNameMatch?.[1]?.trim();
    
    // Extract resource type
    const resourceType: ('collection' | 'resource')[] = [];
    if (/<D:collection/i.test(content)) {
      resourceType.push('collection');
    } else {
      resourceType.push('resource');
    }
    
    // Extract content type
    const contentTypeMatch = content.match(/<D:getcontenttype[^>]*>([^<]+)<\/D:getcontenttype>/i);
    const getContentType = contentTypeMatch?.[1]?.trim();
    
    // Extract content length
    const contentLengthMatch = content.match(/<D:getcontentlength[^>]*>([^<]+)<\/D:getcontentlength>/i);
    const getContentLength = contentLengthMatch?.[1] ? parseInt(contentLengthMatch[1], 10) : undefined;
    
    // Extract last modified
    const lastModifiedMatch = content.match(/<D:getlastmodified[^>]*>([^<]+)<\/D:getlastmodified>/i);
    const getLastModified = lastModifiedMatch?.[1]?.trim();
    
    // Extract created date
    const createdMatch = content.match(/<D:creationdate[^>]*>([^<]+)<\/D:creationdate>/i);
    const getCreated = createdMatch?.[1]?.trim();
    
    // Extract ETag
    const etagMatch = content.match(/<D:getetag[^>]*>([^<]+)<\/D:getetag>/i);
    const getEtag = etagMatch?.[1]?.trim();
    
    // Extract quota used
    const quotaUsedMatch = content.match(/<Q:quota-used-bytes[^>]*>([^<]+)<\/Q:quota-used-bytes>/i);
    const quotaUsed = quotaUsedMatch?.[1] ? parseInt(quotaUsedMatch[1], 10) : undefined;
    
    // Extract quota available
    const quotaAvailableMatch = content.match(/<Q:quota-available-bytes[^>]*>([^<]+)<\/Q:quota-available-bytes>/i);
    const quotaAvailable = quotaAvailableMatch?.[1] ? parseInt(quotaAvailableMatch[1], 10) : undefined;
    
    return {
      href,
      status,
      displayName,
      resourceType,
      getContentType,
      getContentLength,
      getLastModified,
      getCreated,
      getEtag,
      quotaUsed,
      quotaAvailable,
    };
  }

  /**
   * Check if an entry represents a collection (directory).
   */
  private isCollection(entry: PropfindResponseEntry): boolean {
    return entry.resourceType?.includes('collection') ?? false;
  }

  /**
   * Parse a WebDAV folder from a PROPFIND entry.
   */
  private parseFolderFromEntry(entry: PropfindResponseEntry): WebDAVFolder | null {
    if (!this.isCollection(entry)) {
      return null;
    }
    
    const folder: WebDAVFolder = {
      path: entry.href,
      name: entry.displayName || this.extractNameFromPath(entry.href),
      isDirectory: true,
      description: undefined,
      quota: undefined,
      createdAt: undefined,
      modifiedAt: undefined,
    };
    
    if (entry.getCreated) {
      folder.createdAt = this.parseDate(entry.getCreated);
    }
    
    if (entry.getLastModified) {
      folder.modifiedAt = this.parseDate(entry.getLastModified);
    }
    
    if (entry.quotaUsed !== undefined || entry.quotaAvailable !== undefined) {
      folder.quota = {
        used: entry.quotaUsed || 0,
        available: entry.quotaAvailable,
      };
    }
    
    return folder;
  }

  /**
   * Parse a WebDAV file from a PROPFIND entry.
   */
  private parseFileFromEntry(entry: PropfindResponseEntry): WebDAVFile | null {
    if (this.isCollection(entry)) {
      return null;
    }
    
    // Extract basename from href, percent-decoded
    // The href may be root-relative (e.g., /remote.php/dav/files/user/file.txt)
    const pathFromHref = new URL(entry.href, 'http://localhost').pathname;
    const name = decodeURIComponent(pathFromHref.split('/').filter(Boolean).pop() ?? '');
    
    const file: WebDAVFile = {
      path: name,  // Use basename as the path (natural key)
      name: name,
      isDirectory: false,
      size: entry.getContentLength || 0,
      modifiedAt: entry.getLastModified ? this.parseDate(entry.getLastModified) : new Date().toISOString(),
      etag: this.cleanEtag(entry.getEtag || ''),
      resourceType: 'file',
    };
    
    if (entry.getContentType) {
      file.mimeType = entry.getContentType;
      file.contentType = entry.getContentType;
    }
    
    if (entry.getCreated) {
      file.createdAt = this.parseDate(entry.getCreated);
    }
    
    if (entry.quotaUsed !== undefined) {
      file.quotaUsed = entry.quotaUsed;
    }
    
    if (entry.quotaAvailable !== undefined) {
      file.quotaAvailable = entry.quotaAvailable;
    }
    
    return file;
  }

  /**
   * Check if a file has changed since the cursor.
   * Uses ETag as primary indicator, with size and mtime as fallbacks.
   */
  private hasChanged(file: WebDAVFile, cursor?: SyncCursor): boolean {
    if (!cursor) {
      // No cursor means full sync - everything is "changed"
      return true;
    }
    
    try {
      const cursorData = this.decodeCursor(cursor.value);
      
      // Primary check: ETag comparison
      if (cursorData.etags && cursorData.etags[file.path]) {
        const prevEtag = cursorData.etags[file.path];
        const currentEtag = file.etag;
        
        if (prevEtag === currentEtag) {
          // ETag unchanged, check size as secondary indicator
          if (cursorData.sizes && cursorData.sizes[file.path] === file.size) {
            // Size also unchanged, check mtime as tertiary indicator
            if (cursorData.mtimes && cursorData.mtimes[file.path] === file.modifiedAt) {
              return false; // No change detected
            }
          }
        }
      }
      
      return true; // File has changed or not in cursor
    } catch {
      // Invalid cursor, treat as full sync
      return true;
    }
  }

  /**
   * Build a cursor from folder path and file list.
   */
  private buildCursor(folderPath: string, items: RawFileItem[]): string {
    const etags: Record<string, string> = {};
    const sizes: Record<string, number> = {};
    const mtimes: Record<string, string> = {};
    
    for (const item of items) {
      const filePath = item.item.path;
      if (item.item.etag) {
        etags[filePath] = item.item.etag;
      }
      sizes[filePath] = item.item.size;
      mtimes[filePath] = item.item.modifiedAt;
    }
    
    const cursorData = {
      folder: folderPath,
      etags,
      sizes,
      mtimes,
    };
    
    return Buffer.from(JSON.stringify(cursorData)).toString('base64');
  }

  /**
   * Decode a cursor from its string representation.
   */
  private decodeCursor(cursorValue: string): {
    folder: string;
    etags: Record<string, string>;
    sizes: Record<string, number>;
    mtimes: Record<string, string>;
  } {
    const decoded = Buffer.from(cursorValue, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  }

  /**
   * Clean an ETag by removing surrounding quotes if present.
   * ETags can be weak (W/...) or strong, with or without quotes.
   */
  private cleanEtag(etag: string): string {
    if (!etag) {
      return '';
    }
    
    // Remove surrounding quotes
    let cleaned = etag.trim();
    if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
      cleaned = cleaned.slice(1, -1);
    }
    
    return cleaned;
  }

  /**
   * Parse a date string from WebDAV format to ISO 8601.
   */
  private parseDate(dateStr: string): string {
    try {
      // Try to parse as-is first
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return date.toISOString();
      }
      
      // Handle common WebDAV date formats
      // RFC 1123 format: "Mon, 09 Jan 2023 15:30:00 GMT"
      return date.toISOString();
    } catch {
      // Fallback to current time if parsing fails
      return new Date().toISOString();
    }
  }

  /**
   * Extract the file/folder name from a path.
   */
  private extractNameFromPath(path: string): string {
    const normalized = this.normalizePath(path);
    const parts = normalized.split('/').filter(p => p.length > 0);
    return parts[parts.length - 1] || 'root';
  }

  /**
   * Normalize a path to ensure consistent format.
   * - Replaces backslashes with forward slashes
   * - Collapses multiple consecutive slashes
   * - Ensures leading slash
   * - Removes trailing slashes (except for root)
   */
  private normalizePath(path: string): string {
    let normalized = path.replace(/\\/g, '/');
    
    // Collapse multiple consecutive slashes to a single slash
    normalized = normalized.replace(/\/+/g, '/');
    
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    
    // Remove trailing slashes, but keep root as '/'
    if (normalized !== '/' && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    
    return normalized;
  }

  /**
   * Build a URL by appending a relative path to the configured base URL.
   * Used for config-derived paths (e.g., rootPath, folder paths from our config).
   * Rule B: APPEND the path to the base, preserving any subpath prefix.
   * 
   * Examples:
   * - buildUrl('/documents') with base 'https://example.com/webdav' → 'https://example.com/webdav/documents'
   * - buildUrl('files/test.txt') with base 'https://example.com/webdav' → 'https://example.com/webdav/files/test.txt'
   */
  private buildUrl(relativePath: string): string {
    // Handle empty path case - return base URL without trailing slash
    if (relativePath === '') {
      return this.config.url.replace(/\/$/, '');
    }
    
    const baseUrl = this.config.url.endsWith('/') 
      ? this.config.url 
      : this.config.url + '/';
    
    // Remove leading slash from relative path to avoid double slash
    const path = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    
    return baseUrl + path;
  }

  /**
   * Resolve a server-returned href against the base URL's origin.
   * Used for hrefs returned by the server in PROPFIND multistatus responses.
   * Rule A: REPLACE the base path with the server's origin + the href path.
   * 
   * Examples:
   * - resolveHref('/remote.php/dav/files/user/Documents/') with base 'http://host:1/remote.php/dav' 
   *   → 'http://host:1/remote.php/dav/files/user/Documents/'
   * - resolveHref('/documents/report.pdf') with base 'https://example.com/webdav'
   *   → 'https://example.com/documents/report.pdf' (server href replaces base path)
   */
  private resolveHref(href: string): string {
    const baseUrl = this.config.url;
    const origin = new URL(baseUrl).origin;
    
    // Ensure href starts with / for proper resolution
    const normalizedHref = href.startsWith('/') ? href : '/' + href;
    
    return new URL(normalizedHref, origin).toString();
  }

  /**
   * Get the authorization header value.
   * Password is read from the environment variable specified in config.
   */
  private getAuthorizationHeader(): string {
    const password = process.env[this.config.passwordEnv];
    if (!password) {
      throw new Error(`Password environment variable ${this.config.passwordEnv} not set`);
    }
    const credentials = Buffer.from(`${this.config.username}:${password}`).toString('base64');
    return `Basic ${credentials}`;
  }
}

/**
 * Create a default HTTP client using Node.js fetch.
 */
function createDefaultHttpClient(): HttpClient {
  return {
    async request(options: HttpRequestOptions): Promise<HttpResponse> {
      let body: string | ArrayBuffer | Uint8Array | Buffer | undefined;
      
      if (typeof options.body === 'string') {
        body = options.body;
      } else if (Buffer.isBuffer(options.body)) {
        body = options.body;
      } else if (options.body instanceof Uint8Array) {
        // Convert Uint8Array to ArrayBuffer for fetch
        // Use slice to get the correct portion of the buffer
        const arrayBuffer = options.body.buffer as ArrayBuffer;
        body = arrayBuffer.slice(
          options.body.byteOffset,
          options.body.byteOffset + options.body.byteLength
        );
      }

      const response = await fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: body as string | ArrayBuffer | Uint8Array | Buffer | undefined,
      });

      const bodyText = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        status: response.status,
        body: bodyText,
        headers,
      };
    },
  };
}
