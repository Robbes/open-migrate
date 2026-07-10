/**
 * Graph Contacts Source Types
 * 
 * Types for Microsoft Graph Contacts API implementation.
 * Follows Microsoft Graph API v1.0 for contact synchronization.
 */

/**
 * Configuration for Graph Contacts source connection.
 */
export interface GraphContactsSourceConfig {
  /** Microsoft Graph API base URL (default: https://graph.microsoft.com/v1.0) */
  baseUrl?: string;
  /** Azure AD tenant ID */
  tenantId: string;
}

/**
 * Microsoft Graph contact folder object.
 */
export interface GraphContactFolder {
  /** The folder ID */
  readonly id: string;
  /** Display name of the folder */
  readonly name: string;
  /** Parent folder ID */
  readonly parentFolderId?: string;
  /** Total count of items */
  readonly totalItemCount?: number;
  /** Unread count */
  readonly unreadItemCount?: number;
  /** Child folders */
  readonly childFolderCount?: number;
  /** Is system folder flag */
  readonly isTombstone?: boolean;
  /** Is hidden flag */
  readonly isHidden?: boolean;
}

/**
 * Microsoft Graph contact object (metadata only).
 */
export interface GraphContact {
  /** The contact ID */
  readonly id: string;
  /** Display name / full name */
  readonly displayName?: string;
  /** Given name */
  readonly givenName?: string;
  /** Family name / surname */
  readonly surname?: string;
  /** Middle name */
  readonly middleName?: string;
  /** Nickname */
  readonly nickname?: string;
  /** File as (sort order) */
  readonly fileAs?: string;
  /** Job title */
  readonly jobTitle?: string;
  /** Company name */
  readonly companyName?: string;
  /** Department */
  readonly department?: string;
  /** Office location */
  readonly officeLocation?: string;
  /** Business phones */
  readonly businessPhones?: string[];
  /** Mobile phone */
  readonly mobilePhone?: string;
  /** Home phones */
  readonly homePhones?: string[];
  /** Other phones */
  readonly otherPhones?: string[];
  /** Business address */
  readonly businessAddress?: GraphPhysicalAddress;
  /** Home address */
  readonly homeAddress?: GraphPhysicalAddress;
  /** Other address */
  readonly otherAddress?: GraphPhysicalAddress;
  /** Email addresses */
  readonly emailAddresses?: GraphEmailAddress[];
  /** Personal notes */
  readonly personalNotes?: string;
  /** Categories */
  readonly categories?: string[];
  /** Birthday */
  readonly birthday?: string;
  /** Spouse name */
  readonly spouseName?: string;
  /** Children */
  readonly children?: string[];
  /** Web pages / URLs */
  readonly websites?: GraphWebsite[];
  /** Location */
  readonly location?: string;
  /** Photo (thumbnail) */
  readonly photo?: GraphContactPhoto;
  /** Photo blob (for fetching full photo) */
  readonly photoId?: string;
  /** Change key for optimistic concurrency */
  readonly changeKey?: string;
  /** OData next link for pagination */
  readonly '@odata.nextLink'?: string;
  /** OData delta link for incremental sync */
  readonly '@odata.deltaLink'?: string;
}

/**
 * Physical address in Graph API.
 */
export interface GraphPhysicalAddress {
  /** Street address */
  readonly street?: string;
  /** City */
  readonly city?: string;
  /** State/province */
  readonly state?: string;
  /** Postal code */
  readonly postalCode?: string;
  /** Country/region */
  readonly countryOrRegion?: string;
}

/**
 * Email address in Graph API.
 */
export interface GraphEmailAddress {
  /** Email address */
  readonly address: string;
  /** Display name */
  readonly name?: string;
  /** Type (home, work, other) */
  readonly type?: string;
}

/**
 * Website in Graph API.
 */
export interface GraphWebsite {
  /** URL */
  readonly address: string;
  /** Type (home, work, profile, other) */
  readonly type?: string;
}

/**
 * Photo in Graph API.
 */
export interface GraphContactPhoto {
  /** Photo ID */
  readonly id?: string;
  /** Photo width */
  readonly width?: number;
  /** Photo height */
  readonly height?: number;
  /** Photo content (base64) - only available when $value is requested */
  readonly '@odata.mediaContentType'?: string;
}

/**
 * Graph API response for contact folders list.
 */
export interface GraphContactFolderListResponse {
  /** List of contact folders */
  readonly value: GraphContactFolder[];
  /** Next page link for pagination */
  readonly '@odata.nextLink'?: string;
}

/**
 * Graph API response for contacts list.
 */
export interface GraphContactListResponse {
  /** List of contacts */
  readonly value: GraphContact[];
  /** Next page link for pagination */
  readonly '@odata.nextLink'?: string;
  /** Delta link for incremental sync */
  readonly '@odata.deltaLink'?: string;
}

/**
 * Graph contact with photo data (extended type for photo handling).
 */
export interface GraphContactWithPhoto extends GraphContact {
  /** Photo data as base64 */
  photoData?: string;
  /** Photo MIME type */
  photoMimeType?: string;
}

/**
 * Graph API response for delta query.
 */
export interface GraphContactsDeltaQueryResponse {
  /** List of changed contacts */
  readonly value: GraphContact[];
  /** Delta link for next incremental sync */
  readonly '@odata.deltaLink': string;
  /** Next page link for pagination */
  readonly '@odata.nextLink'?: string;
}

/**
 * Delta cursor for Graph Contacts sync.
 */
export interface GraphContactsDeltaCursor {
  /** The delta token/URL */
  readonly deltaLink: string;
  /** Contact folder path this cursor applies to */
  readonly folderPath: string;
}

/**
 * vCard 4.0 field mapping result.
 */
export interface VCardFieldMapping {
  /** vCard UID */
  uid: string;
  /** vCard FN (formatted name) */
  fn: string;
  /** vCard N (name components) */
  n: {
    family: string;
    given: string;
    additional: string[];
    prefix: string[];
    suffix: string[];
  };
  /** vCard ORG (organization) */
  org?: {
    name: string;
    department?: string;
  };
  /** vCard TITLE */
  title?: string;
  /** vCard TEL entries */
  tel?: Array<{
    value: string;
    params: Record<string, string | string[]>;
  }>;
  /** vCard EMAIL entries */
  email?: Array<{
    value: string;
    params: Record<string, string | string[]>;
  }>;
  /** vCard ADR entries */
  adr?: Array<{
    params: Record<string, string | string[]>;
    value: {
      street: string;
      city: string;
      region: string;
      postal: string;
      country: string;
    };
  }>;
  /** vCard URL entries */
  url?: Array<{
    value: string;
    params: Record<string, string | string[]>;
  }>;
  /** vCard NOTE */
  note?: string;
  /** vCard BDAY */
  bday?: string;
  /** vCard PHOTO */
  photo?: {
    data: string; // base64 encoded
    mimeType: string;
  };
  /** vCard CATEGORIES */
  categories?: string[];
}
