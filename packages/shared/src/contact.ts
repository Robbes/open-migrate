/** CardDAV contact model for migration. */

/** vCard version. */
export type VCardVersion = '3.0' | '4.0';

/** Contact type. */
export type ContactType = 'person' | 'organization' | 'group';

/** Phone type. */
export type PhoneType = 'home' | 'work' | 'mobile' | 'other';

/** Email type. */
export type EmailType = 'home' | 'work' | 'other';

/** Address type. */
export type AddressType = 'home' | 'work' | 'other';

/** URL type. */
export type UrlType = 'home' | 'work' | 'profile' | 'other';

/** Phone number. */
export interface ContactPhone {
  readonly value: string;
  readonly type: PhoneType;
  readonly label?: string;
}

/** Email address. */
export interface ContactEmail {
  readonly value: string;
  readonly type: EmailType;
  readonly label?: string;
}

/** Physical address. */
export interface ContactAddress {
  readonly type: AddressType;
  readonly street?: string;
  readonly city?: string;
  readonly region?: string;
  readonly postalCode?: string;
  readonly country?: string;
  readonly label?: string;
}

/** URL. */
export interface ContactUrl {
  readonly value: string;
  readonly type: UrlType;
  readonly label?: string;
}

/** Organization. */
export interface ContactOrganization {
  readonly name: string;
  readonly title?: string;
  readonly department?: string;
}

/** Photo/binary data. */
export interface ContactPhoto {
  readonly data: string; // base64 or URL
  readonly mimeType: string;
}

/**
 * Normalized contact (vCard).
 * The `uid` is the natural key (idempotency anchor); content is hashed from normalized vCard.
 */
export interface Contact {
  /** RFC 6350 UID - the natural key for idempotency. */
  readonly uid: string;
  /** Contact type. */
  readonly type: ContactType;
  /** Full name. */
  readonly name: string;
  /** Given name. */
  readonly givenName?: string;
  /** Family name. */
  readonly familyName?: string;
  /** Additional names. */
  readonly additionalNames?: ReadonlyArray<string>;
  /** Nickname. */
  readonly nickname?: string;
  /** Organization. */
  readonly organization?: ContactOrganization;
  /** Phone numbers. */
  readonly phones?: ReadonlyArray<ContactPhone>;
  /** Email addresses. */
  readonly emails?: ReadonlyArray<ContactEmail>;
  /** Physical addresses. */
  readonly addresses?: ReadonlyArray<ContactAddress>;
  /** URLs. */
  readonly urls?: ReadonlyArray<ContactUrl>;
  /** Note. */
  readonly note?: string;
  /** Birthday. */
  readonly birthday?: string;
  /** Anniversary. */
  readonly anniversary?: string;
  /** Photo. */
  readonly photo?: ContactPhoto;
  /** Categories/tags. */
  readonly categories?: ReadonlyArray<string>;
  /** Source address book collection. */
  readonly sourcePath: string;
  /** Raw vCard data. */
  readonly vcard: string;
  /** vCard version. */
  readonly version: VCardVersion;
}

/** Contact folder/address book. */
export interface ContactFolder {
  /** Address book collection path. */
  readonly path: string;
  /** Human-readable name. */
  readonly name?: string;
  /** Address book description. */
  readonly description?: string;
  /** Supported vCard versions. */
  readonly supportedVersions?: ReadonlyArray<VCardVersion>;
}

/** Contact item with raw data. */
export interface RawContact {
  readonly item: Contact;
  readonly vcard: string;
}
