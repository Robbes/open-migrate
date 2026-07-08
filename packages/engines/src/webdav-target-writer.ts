/**
 * WebDAV Target Writer Implementation
 * 
 * Implements FileTargetWriter interface for WebDAV file synchronization.
 * Uses rclone for bulk operations and direct WebDAV API calls for individual operations.
 * Follows the idempotency pattern with ledger fast-path and target-side existence checks.
 */

import type {
  FileTargetWriter,
  FileFolder,
  RawFileItem,
  UpsertResult,
  Ledger,
  TenantId,
  MappingId,
} from '@openmig/shared';
import { fileNaturalKeyHash, fileContentHash } from '@openmig/shared';

/**
 * Configuration for WebDAV target writer
 */
export interface WebDAVTargetConfig {
  /** WebDAV endpoint URL */
  url: string;
  /** Authentication username */
  username: string;
  /** Authentication password or token */
  password: string;
  /** Root path for file storage */
  rootPath?: string;
  /** Use chunked uploads for large files */
  chunkedUploads?: boolean;
  /** Chunk size for chunked uploads (in bytes) */
  chunkSize?: number;
}

/**
 * WebDAV target writer implementation
 */
export class WebDAVTargetWriter implements FileTargetWriter {
  private readonly config: WebDAVTargetConfig;
  private readonly ledger: Ledger;
  private readonly tenantId: TenantId;
  private readonly mappingId: MappingId;
  private readonly httpClient: HttpClient;

  constructor(
    config: WebDAVTargetConfig,
    deps: {
      ledger: Ledger;
      tenantId: TenantId;
      mappingId: MappingId;
      httpClient?: HttpClient;
    },
  ) {
    this.config = config;
    this.ledger = deps.ledger;
    this.tenantId = deps.tenantId;
    this.mappingId = deps.mappingId;
    this.httpClient = deps.httpClient ?? createDefaultHttpClient();
  }

  /**
   * Ensure a directory exists with the given folder metadata.
   * Returns the directory ID (path) for use in subsequent operations.
   */
  async ensureDirectory(folder: FileFolder): Promise<string> {
    const directoryPath = this.normalizePath(folder.path ?? folder.name ?? 'files');
    
    // Check if directory already exists via PROPFIND
    const exists = await this.directoryExists(directoryPath);
    if (exists) {
      return directoryPath;
    }

    // Create new directory using MKCOL
    await this.createDirectory(directoryPath, folder);
    return directoryPath;
  }

  /**
   * Idempotently write a file to the target.
   * Uses ledger fast-path and target-side existence check to ensure idempotency.
   */
  async upsertFile(
    parentId: string,
    raw: RawFileItem,
  ): Promise<UpsertResult> {
    // Use file path as natural key
    const naturalKey = raw.item.path;
    const naturalKeyHash = fileNaturalKeyHash(naturalKey);

    // LEDGER FAST-PATH: Check if already migrated
    const known = await this.ledger.find(this.tenantId, this.mappingId, naturalKeyHash);
    if (known) {
      return { targetId: known.targetId, created: false };
    }

    // Compute content hash for change detection (only for files with content, not directories)
    const contentHashValue = raw.content ? fileContentHash(raw.content) : fileContentHash(new Uint8Array(0));

    // Check if file already exists on target
    const existingId = await this.findFileByNaturalKey(parentId, naturalKey);
    if (existingId) {
      // Record in ledger if not present (adopt existing)
      await this.ledger.recordIfAbsent({
        tenantId: this.tenantId,
        mappingId: this.mappingId,
        naturalKeyHash,
        contentHash: contentHashValue,
        targetId: existingId,
        createdAt: new Date().toISOString(),
      });
      return { targetId: existingId, created: false };
    }

    // Upload the file to the target
    const fileId = await this.uploadFile(parentId, raw);

    // RECORD IN LEDGER
    await this.ledger.recordIfAbsent({
      tenantId: this.tenantId,
      mappingId: this.mappingId,
      naturalKeyHash,
      contentHash: contentHashValue,
      targetId: fileId,
      createdAt: new Date().toISOString(),
    });

    return { targetId: fileId, created: true };
  }

  /**
   * Find a file by its natural key (path).
   * Returns the file ID if found, undefined otherwise.
   */
  async findFileByNaturalKey(
    parentId: string,
    naturalKey: string,
  ): Promise<string | undefined> {
    // Use WebDAV PROPFIND to check if file exists
    const filePath = this.buildFilePath(parentId, naturalKey);
    
    try {
      const response = await this.httpClient.request({
        method: 'PROPFIND',
        url: this.buildUrl(filePath),
        headers: {
          Depth: '0',
          Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`,
        },
      });

      if (response.status === 207 || response.status === 200) {
        return filePath;
      }
    } catch {
      // File doesn't exist
    }

    return undefined;
  }

  // Private helper methods

  private normalizePath(path: string): string {
    // Normalize path to ensure consistent format
    let normalized = path.replace(/\\/g, '/');
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    // Remove trailing slashes for files, keep for directories
    return normalized;
  }

  private async directoryExists(path: string): Promise<boolean> {
    try {
      const response = await this.httpClient.request({
        method: 'PROPFIND',
        url: this.buildUrl(path),
        headers: {
          Depth: '0',
          Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`,
        },
      });
      return response.status === 207 || response.status === 200;
    } catch {
      return false;
    }
  }

  private async createDirectory(path: string, _folder: FileFolder): Promise<void> {
    await this.httpClient.request({
      method: 'MKCOL',
      url: this.buildUrl(path),
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`,
      },
    });
  }

  private async uploadFile(parentId: string, raw: RawFileItem): Promise<string> {
    const filePath = this.buildFilePath(parentId, raw.item.path);
    
    // Check if file is large and should use chunked upload
    const useChunked = this.config.chunkedUploads && 
                      raw.content && raw.content.length > (this.config.chunkSize || 10 * 1024 * 1024);

    if (useChunked && raw.content) {
      return await this.uploadFileChunked(filePath, raw.content);
    }

    // Simple PUT for small files - only if content exists
    if (raw.content) {
      await this.httpClient.request({
        method: 'PUT',
        url: this.buildUrl(filePath),
        body: raw.content,
        headers: {
          'Content-Type': raw.item.mimeType || 'application/octet-stream',
          Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`,
        },
      });
    }

    return filePath;
  }

  private async uploadFileChunked(
    filePath: string,
    content: Uint8Array,
  ): Promise<string> {
    const chunkSize = this.config.chunkSize || 10 * 1024 * 1024; // 10MB default
    const totalChunks = Math.ceil(content.length / chunkSize);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, content.length);
      const chunk = content.slice(start, end);

      const range = `bytes=${start}-${end - 1}/${content.length}`;

      await this.httpClient.request({
        method: 'PUT',
        url: this.buildUrl(filePath),
        body: chunk,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': range,
          Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`,
        },
      });
    }

    return filePath;
  }

  private buildFilePath(parentId: string, fileName: string): string {
    const parent = parentId.replace(/\/+$/, '');
    const name = fileName.replace(/^\/+/, '');
    return `${parent}/${name}`;
  }

  private buildUrl(path: string): string {
    const baseUrl = this.config.url.replace(/\/$/, '');
    const normalizedPath = path.replace(/^\/+/, '');
    return `${baseUrl}/${normalizedPath}`;
  }
}

/**
 * HTTP client interface for WebDAV requests
 */
export interface HttpClient {
  request(options: HttpRequestOptions): Promise<HttpResponse>;
}

export interface HttpRequestOptions {
  method: string;
  url: string;
  body?: string | Buffer | Uint8Array;
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/**
 * Create a default HTTP client using Node.js fetch
 */
function createDefaultHttpClient(): HttpClient {
  return {
    async request(options: HttpRequestOptions): Promise<HttpResponse> {
      const response = await fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
      });

      const body = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        status: response.status,
        body,
        headers,
      };
    },
  };
}
