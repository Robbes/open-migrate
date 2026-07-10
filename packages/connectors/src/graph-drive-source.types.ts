/**
 * Graph Drive Source Types
 * 
 * Types for Microsoft Graph Drive API implementation (OneDrive/SharePoint).
 * Follows Microsoft Graph API v1.0 for file synchronization.
 */

import type { TokenProvider } from '@openmig/shared';

/**
 * Configuration for Graph Drive source connection.
 */
export interface GraphDriveSourceConfig {
  readonly tokenProvider: TokenProvider;
  readonly tenantId: string;
  readonly baseUrl?: string;
}

/**
 * Microsoft Graph drive item (file or folder).
 */
export interface GraphDriveItem {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly lastModifiedDateTime: string;
  readonly cTag?: string;
  readonly quickXorHash?: string;
  readonly file?: { mimeType?: string };
  readonly folder?: { childCount?: number };
  readonly deleted?: object;
  readonly '@odata.deltaLink'?: string;
}

/**
 * Graph API response for delta query.
 */
export interface GraphDriveDeltaResponse {
  readonly value: GraphDriveItem[];
  readonly '@odata.deltaLink'?: string;
  readonly '@odata.nextLink'?: string;
}

/**
 * Delta cursor for Graph Drive sync.
 */
export interface GraphDriveDeltaCursor {
  readonly deltaLink: string;
  readonly folderPath: string;
}

/**
 * Parsed path components for natural key generation.
 */
export interface ParsedPath {
  readonly root: string;
  readonly dir: string;
  readonly base: string;
  readonly ext: string;
  readonly name: string;
}

/**
 * Normalized path options.
 */
export interface NormalizePathOptions {
  readonly collapseSlashes?: boolean;
  readonly resolveDots?: boolean;
  readonly removeTrailingSlash?: boolean;
}
