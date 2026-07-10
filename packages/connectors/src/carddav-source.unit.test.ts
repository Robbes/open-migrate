/**
 * CardDAV Source Unit Tests
 * 
 * Tests for CarddavSource implementation covering:
 * - PROPFIND parsing for address book home discovery
 * - sync-collection REPORT parsing
 * - UID extraction from vCard
 * - **Case-sensitive UID handling** (RFC 6350)
 */

import { describe, it, expect, vi } from 'vitest';
import { CarddavSource } from './carddav-source';
import type { CardDAVSourceConfig, CardDAVSyncToken } from './carddav-source.types';
import type { HttpClient, HttpResponse } from './dav-http.types';

// Mock HTTP client for testing
function createMockHttpClient(response: HttpResponse): HttpClient {
  return {
    request: vi.fn().mockResolvedValue(response),
  };
}

describe('CarddavSource', () => {
  describe('PROPFIND parsing', () => {
    it('should parse address book home set from PROPFIND response', async () => {
      const propfindResponse: HttpResponse = {
        status: 207,
        body: `<?xml version="1.0" encoding="utf-8"?>
          <D:multistatus xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav">
            <D:response>
              <D:href>/dav/user/test/</D:href>
              <D:propstat>
                <D:prop>
                  <A:addressbook-home-set>/dav/addressbooks/user/test/</A:addressbook-home-set>
                </D:prop>
                <D:status>HTTP/1.1 200 OK</D:status>
              </D:propstat>
            </D:response>
          </D:multistatus>`,
        headers: {},
      };

      const config: CardDAVSourceConfig = {
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      };

      const source = new CarddavSource(config, { httpClient: createMockHttpClient(propfindResponse) });

      // Access private method via type casting for testing
      const homeSet = (source as any).parseAddressBookHomeSetResponse(propfindResponse.body);
      expect(homeSet).toBe('/dav/addressbooks/user/test/');
    });

    it('should parse address book collections from PROPFIND response', async () => {
      const propfindResponse: HttpResponse = {
        status: 207,
        body: `<?xml version="1.0" encoding="utf-8"?>
          <D:multistatus xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav" xmlns:CR="urn:ietf:params:xml:ns:carddav">
            <D:response>
              <D:href>/dav/addressbooks/user/test/contacts/</D:href>
              <D:propstat>
                <D:prop>
                  <D:displayname>Contacts</D:displayname>
                  <D:resourcetype><D:collection/><A:addressbook/></D:resourcetype>
                  <A:addressbook-description>Personal contacts</A:addressbook-description>
                  <CR:color>#1f8aff</CR:color>
                </D:prop>
                <D:status>HTTP/1.1 200 OK</D:status>
              </D:propstat>
            </D:response>
            <D:response>
              <D:href>/dav/addressbooks/user/test/family/</D:href>
              <D:propstat>
                <D:prop>
                  <D:displayname>Family</D:displayname>
                  <D:resourcetype><D:collection/><A:addressbook/></D:resourcetype>
                  <A:addressbook-description>Family contacts</A:addressbook-description>
                </D:prop>
                <D:status>HTTP/1.1 200 OK</D:status>
              </D:propstat>
            </D:response>
          </D:multistatus>`,
        headers: {},
      };

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const collections = (source as any).parseCollectionsResponse(propfindResponse.body, '/dav/addressbooks/user/test/');
      
      expect(collections).toHaveLength(2);
      expect(collections[0]).toMatchObject({
        path: '/dav/addressbooks/user/test/contacts/',
        name: 'Contacts',
        description: 'Personal contacts',
        color: '#1f8aff',
      });
      expect(collections[1]).toMatchObject({
        path: '/dav/addressbooks/user/test/family/',
        name: 'Family',
        description: 'Family contacts',
      });
    });

    it('should handle empty PROPFIND response', async () => {
      const propfindResponse: HttpResponse = {
        status: 207,
        body: `<?xml version="1.0" encoding="utf-8"?>
          <D:multistatus xmlns:D="DAV:">
          </D:multistatus>`,
        headers: {},
      };

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const collections = (source as any).parseCollectionsResponse(propfindResponse.body, '/home/');
      expect(collections).toHaveLength(0);
    });
  });

  describe('sync-collection REPORT parsing', () => {
    it('should parse sync-collection REPORT with sync-token', async () => {
      const reportResponse: HttpResponse = {
        status: 207,
        body: `<?xml version="1.0" encoding="utf-8"?>
          <D:multistatus xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav">
            <D:sync-token>https://carddav.example.com/token/abc123</D:sync-token>
            <D:response>
              <D:href>/dav/addressbooks/user/test/contacts/contact1.vcf</D:href>
              <D:propstat>
                <D:prop>
                  <D:resourcetype/>
                  <A:address-data>BEGIN:VCARD
VERSION:4.0
UID:contact1@example.com
FN:John Doe
EMAIL:john@example.com
END:VCARD
</A:address-data>
                </D:prop>
                <D:status>HTTP/1.1 200 OK</D:status>
              </D:propstat>
            </D:response>
          </D:multistatus>`,
        headers: {},
      };

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const result = (source as any).parseSyncCollectionResponse(reportResponse.body);
      
      expect(result.syncToken).toBe('https://carddav.example.com/token/abc123');
      expect(result.objects).toHaveLength(1);
      expect(result.objects[0].href).toBe('/dav/addressbooks/user/test/contacts/contact1.vcf');
      expect(result.objects[0].vcard).toContain('BEGIN:VCARD');
      expect(result.objects[0].vcard).toContain('UID:contact1@example.com');
    });

    it('should parse sync-collection REPORT with multiple contacts', async () => {
      const reportResponse: HttpResponse = {
        status: 207,
        body: `<?xml version="1.0" encoding="utf-8"?>
          <D:multistatus xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav">
            <D:sync-token>https://carddav.example.com/token/xyz789</D:sync-token>
            <D:response>
              <D:href>/dav/addressbooks/user/test/contacts/john.vcf</D:href>
              <D:propstat>
                <D:prop>
                  <A:address-data>BEGIN:VCARD
VERSION:4.0
UID:john@example.com
FN:John Smith
END:VCARD
</A:address-data>
                </D:prop>
              </D:propstat>
            </D:response>
            <D:response>
              <D:href>/dav/addressbooks/user/test/contacts/jane.vcf</D:href>
              <D:propstat>
                <D:prop>
                  <A:address-data>BEGIN:VCARD
VERSION:4.0
UID:jane@example.com
FN:Jane Doe
END:VCARD
</A:address-data>
                </D:prop>
              </D:propstat>
            </D:response>
          </D:multistatus>`,
        headers: {},
      };

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const result = (source as any).parseSyncCollectionResponse(reportResponse.body);
      
      expect(result.objects).toHaveLength(2);
      expect(result.objects[0].uid).toBe('john@example.com');
      expect(result.objects[1].uid).toBe('jane@example.com');
    });

    it('should handle sync-collection REPORT without sync-token (CTag fallback)', async () => {
      const reportResponse: HttpResponse = {
        status: 207,
        body: `<?xml version="1.0" encoding="utf-8"?>
          <D:multistatus xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:carddav">
            <D:response>
              <D:href>/dav/addressbooks/user/test/contacts/contact1.vcf</D:href>
              <D:propstat>
                <D:prop>
                  <D:getetag>"1234567890"</D:getetag>
                  <A:address-data>BEGIN:VCARD
VERSION:4.0
UID:contact1@example.com
FN:Test Contact
END:VCARD
</A:address-data>
                </D:prop>
              </D:propstat>
            </D:response>
          </D:multistatus>`,
        headers: {},
      };

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const result = (source as any).parseSyncCollectionResponse(reportResponse.body);
      
      expect(result.syncToken).toBeUndefined();
      expect(result.ctag).toBe('"1234567890"');
      expect(result.objects).toHaveLength(1);
    });
  });

  describe('UID extraction from vCard', () => {
    it('should extract UID from vCard 4.0', () => {
      const vcard = `BEGIN:VCARD
VERSION:4.0
UID:contact123@example.com
FN:John Doe
END:VCARD`;

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const uid = (source as any).extractUidFromVcard(vcard);
      expect(uid).toBe('contact123@example.com');
    });

    it('should extract UID from vCard 3.0', () => {
      const vcard = `BEGIN:VCARD
VERSION:3.0
UID:old-contact@example.com
FN:Old Contact
END:VCARD`;

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const uid = (source as any).extractUidFromVcard(vcard);
      expect(uid).toBe('old-contact@example.com');
    });

    it('should return null when UID is missing', () => {
      const vcard = `BEGIN:VCARD
VERSION:4.0
FN:No UID Contact
END:VCARD`;

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const uid = (source as any).extractUidFromVcard(vcard);
      expect(uid).toBeNull();
    });
  });

  describe('Case-sensitive UID handling', () => {
    it('should preserve UID case exactly as-is (RFC 6350)', () => {
      const vcard = `BEGIN:VCARD
VERSION:4.0
UID:CaseSensitive-UID-ABC123@example.com
FN:Test Contact
END:VCARD`;

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const uid = (source as any).extractUidFromVcard(vcard);
      // UID should be preserved exactly - case-sensitive!
      expect(uid).toBe('CaseSensitive-UID-ABC123@example.com');
      expect(uid).not.toBe('casesensitive-uid-abc123@example.com');
    });

    it('should handle mixed case UIDs correctly', () => {
      const vcard = `BEGIN:VCARD
VERSION:4.0
UID:MixedCase-AbCdEf-12345@example.com
FN:Mixed Case Contact
END:VCARD`;

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const uid = (source as any).extractUidFromVcard(vcard);
      expect(uid).toBe('MixedCase-AbCdEf-12345@example.com');
    });

    it('should differentiate between UIDs that differ only by case', () => {
      const vcard1 = `BEGIN:VCARD
VERSION:4.0
UID:uppercase@example.com
FN:Upper Contact
END:VCARD`;

      const vcard2 = `BEGIN:VCARD
VERSION:4.0
UID:lowercase@example.com
FN:Lower Contact
END:VCARD`;

      const vcard3 = `BEGIN:VCARD
VERSION:4.0
UID:UPPERCASE@EXAMPLE.COM
FN:All Upper Contact
END:VCARD`;

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const uid1 = (source as any).extractUidFromVcard(vcard1);
      const uid2 = (source as any).extractUidFromVcard(vcard2);
      const uid3 = (source as any).extractUidFromVcard(vcard3);

      // All three should be different - case matters!
      expect(uid1).toBe('uppercase@example.com');
      expect(uid2).toBe('lowercase@example.com');
      expect(uid3).toBe('UPPERCASE@EXAMPLE.COM');
      expect(uid1).not.toBe(uid2);
      expect(uid1).not.toBe(uid3);
      expect(uid2).not.toBe(uid3);
    });

    it('should preserve UID case in parsed contact', () => {
      const vcard = `BEGIN:VCARD
VERSION:4.0
UID:Preserve-Case-UID-XYZ@example.com
FN:Test Contact
EMAIL:test@example.com
END:VCARD`;

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const contact = (source as any).parseContactObject({
        href: '/dav/addressbooks/user/test/contacts/test.vcf',
        vcard,
      });

      // UID should be preserved exactly - NOT lowercased!
      expect(contact.item.uid).toBe('Preserve-Case-UID-XYZ@example.com');
    });
  });

  describe('Cursor encoding and decoding', () => {
    it('should encode and decode sync-token cursor', () => {
      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const token = 'https://carddav.example.com/token/abc123';
      const encoded = (source as any).encodeSyncToken(token);
      const decoded: CardDAVSyncToken = (source as any).decodeSyncToken({ value: encoded });

      expect(decoded.token).toBe(token);
      expect(decoded.isSyncToken).toBe(true);
    });

    it('should encode and decode CTag cursor', () => {
      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const collectionPath = '/dav/addressbooks/user/test/contacts/';
      const ctag = '"1234567890"';
      const encoded = (source as any).encodeCTag(ctag, collectionPath);
      const decoded: CardDAVSyncToken = (source as any).decodeSyncToken({ value: encoded });

      expect(decoded.token).toBe(ctag);
      expect(decoded.isSyncToken).toBe(false);
      expect(decoded.collectionPath).toBe(collectionPath);
    });

    it('should throw error for invalid cursor format', () => {
      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      expect(() => (source as any).decodeSyncToken({ value: 'invalid-format' })).toThrow();
    });
  });

  describe('XML escaping', () => {
    it('should escape XML special characters', () => {
      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const input = 'Test & <script> "quotes" \'apostrophe\'';
      const escaped = (source as any).escapeXml(input);

      expect(escaped).toBe('Test &amp; &lt;script&gt; &quot;quotes&quot; &apos;apostrophe&apos;');
    });
  });

  describe('XML entity decoding', () => {
    it('should decode XML entities in address data', () => {
      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const encoded = 'Test &lt;description&gt; &amp; more';
      const decoded = (source as any).decodeXmlEntities(encoded);

      expect(decoded).toBe('Test <description> & more');
    });
  });

  describe('Line unfolding', () => {
    it('should unfold vCard lines', () => {
      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      // vCard lines can be folded with leading whitespace (RFC 6350 Section 3.1)
      const folded = `BEGIN:VCARD
VERSION:4.0
NOTE:This is a long note that was
 folded to multiple lines
FN:Test Contact
END:VCARD`;

      const unfolded = (source as any).unfoldAndDecode(folded);

      expect(unfolded).toContain('NOTE:This is a long note that was folded to multiple lines');
    });

    it('should decode vCard special characters', () => {
      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const encoded = 'Test\\nwith\\nnewlines, and\\;semicolons';
      const decoded = (source as any).unfoldAndDecode(encoded);

      expect(decoded).toBe('Test\nwith\nnewlines, and;semicolons');
    });
  });

  describe('Contact parsing', () => {
    it('should parse complete vCard', () => {
      const vcard = `BEGIN:VCARD
VERSION:4.0
UID:complete-contact@example.com
FN:John Doe
N:Doe;John;;;
ORG:Acme Inc.;Development
TITLE:Software Engineer
TEL;HOME:+1-555-123-4567
TEL;WORK;MOBILE:+1-555-987-6543
EMAIL;HOME:john.home@example.com
EMAIL;WORK:john.work@example.com
ADR;HOME:;;123 Main St;Springfield;IL;12345;USA
NOTE:This is a test contact
CATEGORIES:Friends,Work
END:VCARD`;

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const contact = (source as any).parseContactObject({
        href: '/dav/addressbooks/user/test/contacts/john.vcf',
        vcard,
      });

      expect(contact).toMatchObject({
        item: {
          uid: 'complete-contact@example.com',
          type: 'person',
          name: 'John Doe',
          givenName: 'John',
          familyName: 'Doe',
          organization: { name: 'Acme Inc.', title: 'Software Engineer' },
        },
      });
    });

    it('should handle vCard 3.0 format', () => {
      const vcard = `BEGIN:VCARD
VERSION:3.0
UID:vcard3-contact@example.com
FN:Jane Doe
N:Doe;Jane;;;
EMAIL:jane@example.com
END:VCARD`;

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const contact = (source as any).parseContactObject({
        href: '/dav/addressbooks/user/test/contacts/jane.vcf',
        vcard,
      });

      expect(contact.item.uid).toBe('vcard3-contact@example.com');
      expect(contact.item.version).toBe('3.0');
    });

    it('should extract phone numbers correctly', () => {
      const vcard = `BEGIN:VCARD
VERSION:4.0
UID:phone-contact@example.com
FN:Phone Contact
TEL;HOME:+1-555-123-4567
TEL;WORK:+1-555-234-5678
TEL;CELL:+1-555-345-6789
END:VCARD`;

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const phones = (source as any).extractPhones(vcard);

      expect(phones).toHaveLength(3);
      expect(phones[0]).toMatchObject({ value: '+1-555-123-4567', type: 'home' });
      expect(phones[1]).toMatchObject({ value: '+1-555-234-5678', type: 'work' });
      expect(phones[2]).toMatchObject({ value: '+1-555-345-6789', type: 'mobile' });
    });

    it('should extract email addresses correctly', () => {
      const vcard = `BEGIN:VCARD
VERSION:4.0
UID:email-contact@example.com
FN:Email Contact
EMAIL;HOME:home@example.com
EMAIL;WORK:work@example.com
END:VCARD`;

      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      const emails = (source as any).extractEmails(vcard);

      expect(emails).toHaveLength(2);
      expect(emails[0]).toMatchObject({ value: 'home@example.com', type: 'home' });
      expect(emails[1]).toMatchObject({ value: 'work@example.com', type: 'work' });
    });
  });

  describe('Authorization header', () => {
    it('should build correct authorization header', () => {
      process.env.TEST_CARDAVV_PASSWORD = 'secret123';
      
      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'testuser',
        passwordEnv: 'TEST_CARDAVV_PASSWORD',
      });

      const authHeader = (source as any).getAuthorizationHeader();
      const expected = `Basic ${Buffer.from('testuser:secret123').toString('base64')}`;
      
      expect(authHeader).toBe(expected);
    });

    it('should throw error when password env var not set', () => {
      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'testuser',
        passwordEnv: 'NONEXISTENT_PASSWORD_VAR',
      });

      expect(() => (source as any).getAuthorizationHeader()).toThrow();
    });
  });

  describe('Path normalization', () => {
    it('should normalize paths consistently', () => {
      const source = new CarddavSource({
        url: 'https://carddav.example.com/',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      expect((source as any).normalizePath('/path/to/addressbook')).toBe('/path/to/addressbook/');
      expect((source as any).normalizePath('path/to/addressbook/')).toBe('/path/to/addressbook/');
      expect((source as any).normalizePath('path/to/addressbook')).toBe('/path/to/addressbook/');
    });

    it('should build URLs correctly', () => {
      const source = new CarddavSource({
        url: 'https://carddav.example.com',
        username: 'test',
        passwordEnv: 'TEST_PASSWORD',
      });

      expect((source as any).buildUrl('/addressbook/')).toBe('https://carddav.example.com/addressbook/');
      expect((source as any).buildUrl('addressbook')).toBe('https://carddav.example.com/addressbook/');
    });
  });
});
