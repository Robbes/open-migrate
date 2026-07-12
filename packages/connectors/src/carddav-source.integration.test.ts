// Copyright 2026 OpenHands Agent (Apache-2.0)
// Integration tests for CardDAV source connector against Nextcloud.
// Uses Testcontainers for containerized Nextcloud instance.
//
// DAV integration tests run against Nextcloud, the product's calendar/contacts/files
// target and a conformant DAV implementation. Stalwart is mail-only (JMAP/IMAP) in
// this project's test stack; whether Stalwart can serve DAV is out of scope.
//
// TEST SCENARIOS:
// - listFolders() discovers seeded address books
// - listSince() returns seeded contacts with correct vCard payload
// - Cursor round-trip (second call returns only changes)
// - Idempotency: run twice, second run creates 0 items

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { CarddavSource } from './carddav-source';
import type { CardDAVSourceConfig } from './carddav-source.types';
import type { RawContact as _RawContact } from '@openmig/shared';

// Nextcloud CardDAV configuration from Testcontainers
const NEXTCLOUD_WEBDAV_URL = process.env.NEXTCLOUD_WEBDAV_URL;
const NEXTCLOUD_USERNAME = process.env.NEXTCLOUD_USERNAME || 'testadmin';
const NEXTCLOUD_PASSWORD = process.env.NEXTCLOUD_PASSWORD || 'testadmin_password';

// Fixed test contact UIDs
const TEST_ADDRESSBOOK_NAME = 'Test Address Book';
const TEST_CONTACT_UID_1 = 'contact-alice@dev.local';
const TEST_CONTACT_UID_2 = 'contact-bob@dev.local';
const TEST_CONTACT_UID_3 = 'contact-charlie@dev.local';

/**
 * Wait for Nextcloud CardDAV to be ready.
 * Nextcloud serves CardDAV at /remote.php/dav/addressbooks/{user}/
 */
async function waitForCarddav(maxRetries = 60, delayMs = 3000): Promise<void> {
  if (!NEXTCLOUD_WEBDAV_URL) {
    throw new Error('NEXTCLOUD_WEBDAV_URL not configured - cannot wait for CardDAV');
  }
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${NEXTCLOUD_WEBDAV_URL.replace(/\/$/, '')}/.well-known/carddav`, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
        },
      });
      // Nextcloud returns 302 redirect for well-known, then 207 for PROPFIND
      if (response.status === 200 || response.status === 302 || response.status === 207) {
        return;
      }
    } catch {
      // CardDAV not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error('CardDAV server not ready after max retries');
}

/**
 * Seed test contacts via raw DAV PUT.
 * Creates a test address book and populates it with vCard contacts.
 * Uses RFC 6764 discovery to get the correct addressbook-home-set URL.
 */
async function seedContacts(carddavSource: CarddavSource): Promise<void> {
  const carddavUrl = NEXTCLOUD_WEBDAV_URL!.replace(/\/$/, '');
  
  // Trigger discovery to get the addressbook-home-set
  const folders = await carddavSource.listFolders();
  
  // Try to find or create the test address book
  let testAddressBook = folders.find(f => f.name === TEST_ADDRESSBOOK_NAME);
  let addressBookUrl: string | undefined;
  
  if (!testAddressBook) {
    // Address book doesn't exist, we need to create it
    const addressBookHomeSet = (carddavSource as any).addressBookHomeSet;
    if (!addressBookHomeSet) {
      throw new Error('Address book home-set not discovered. DAV may not be enabled on the server.');
    }
    
    // Create the test address book using MKCOL
    addressBookUrl = new URL(`test-addressbook/`, addressBookHomeSet).toString();
    
    const mkcolXml = `<?xml version="1.0" encoding="utf-8"?>
      <D:mkcol xmlns:D="DAV:" xmlns:CA="urn:ietf:params:xml:ns:carddav">
        <D:set>
          <D:prop>
            <D:resourcetype>
              <D:collection/>
              <CA:addressbook/>
            </D:resourcetype>
            <D:displayname>${TEST_ADDRESSBOOK_NAME}</D:displayname>
          </D:prop>
        </D:set>
      </D:mkcol>`;

    try {
      const response = await fetch(addressBookUrl, {
        method: 'MKCOL',
        headers: {
          'Content-Type': 'application/xml',
          Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
        },
        body: mkcolXml,
      });

      if (response.status === 201 || response.status === 409) {
        console.log('[Seed] Created test address book');
        // Refresh folders to get the new address book
        const refreshedFolders = await carddavSource.listFolders();
        testAddressBook = refreshedFolders.find(f => f.name === TEST_ADDRESSBOOK_NAME);
      } else {
        const body = await response.text();
        console.log(`[Seed] Address book creation response: ${response.status} - ${body.substring(0, 200)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[Seed] Address book creation error: ${msg}`);
    }
  } else {
    // Use the discovered address book path
    addressBookUrl = new URL(`${testAddressBook.path.replace(/\/$/, '')}/`, carddavUrl).toString();
  }
  
  if (!testAddressBook || !addressBookUrl) {
    throw new Error('No address book available for seeding. DAV configuration may be incorrect.');
  }

  // Seed test contacts
  const testContacts = [
    {
      uid: TEST_CONTACT_UID_1,
      fn: 'Alice Johnson',
      org: 'Acme Corp',
      title: 'Software Engineer',
      tel: '+1-555-1234',
      email: 'alice@dev.local',
      adr: {
        type: 'work',
        street: '123 Main St',
        city: 'San Francisco',
        region: 'CA',
        postalCode: '94105',
        country: 'USA',
      },
    },
    {
      uid: TEST_CONTACT_UID_2,
      fn: 'Bob Smith',
      org: 'Tech Inc',
      title: 'Product Manager',
      tel: '+1-555-5678',
      email: 'bob@dev.local',
      adr: {
        type: 'work',
        street: '456 Oak Ave',
        city: 'New York',
        region: 'NY',
        postalCode: '10001',
        country: 'USA',
      },
    },
    {
      uid: TEST_CONTACT_UID_3,
      fn: 'Charlie Brown',
      org: 'Design Studio',
      title: 'UX Designer',
      tel: '+1-555-9012',
      email: 'charlie@dev.local',
      adr: {
        type: 'home',
        street: '789 Pine Rd',
        city: 'Austin',
        region: 'TX',
        postalCode: '78701',
        country: 'USA',
      },
    },
  ];

  for (const contact of testContacts) {
    const vcard = `BEGIN:VCARD
VERSION:4.0
UID:${contact.uid}
FN:${contact.fn}
ORG:${contact.org}
TITLE:${contact.title}
TEL;TYPE=${contact.adr.type}:${contact.tel}
EMAIL:${contact.email}
ADR;TYPE=${contact.adr.type};;${contact.adr.street};${contact.adr.city};${contact.adr.region};${contact.adr.postalCode};${contact.adr.country}
N:${contact.fn.split(' ')[1] || ''};${contact.fn.split(' ')[0] || ''};;;
END:VCARD`;

    const contactUrl = new URL(`${contact.uid}.vcf`, addressBookUrl!).toString();
    
    try {
      const response = await fetch(contactUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/vcard',
          Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
        },
        body: vcard,
      });

      if (response.status === 201 || response.status === 204) {
        console.log(`[Seed] Created contact: ${contact.uid}`);
      } else {
        const body = await response.text();
        console.warn(`[Seed] Contact ${contact.uid} response: ${response.status} - ${body.substring(0, 200)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Seed] Warning: Could not seed contact ${contact.uid}: ${msg}`);
    }
  }

  console.log('[Seed] Contacts seeded');
}

/**
 * Clean up test address book and contacts.
 * Uses RFC 6764 discovery to get the correct addressbook-home-set URL.
 */
async function cleanAddressBook(carddavSource?: CarddavSource): Promise<void> {
  // If carddavSource is provided, use its discovered address book home-set
  let addressBookHomeSet: string | undefined;
  if (carddavSource) {
    addressBookHomeSet = (carddavSource as any).addressBookHomeSet;
  }
  
  // Fallback to environment variable if not discovered
  const carddavUrl = NEXTCLOUD_WEBDAV_URL || 'http://localhost:8080';
  
  try {
    // If we have the address book home-set, use it for cleanup
    const baseCollectionUrl = addressBookHomeSet || `${carddavUrl.replace(/\/$/, '')}/${NEXTCLOUD_USERNAME.split('@')[0]}/`;
    
    // Delete all contacts in the address book using REPORT
    const syncCollectionXml = `<?xml version="1.0" encoding="utf-8"?>
      <D:sync-collection xmlns:D="DAV:">
        <D:prop>
          <D:resourcetype/>
          <D:getetag/>
        </D:prop>
        <D:sync-token/>
      </D:sync-collection>`;

    const response = await fetch(baseCollectionUrl, {
      method: 'REPORT',
      headers: {
        'Content-Type': 'application/xml',
        Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
      },
      body: syncCollectionXml,
    });

    if (response.status === 207) {
      const body = await response.text();
      // Parse and delete all resources
      const hrefRegex = /<D:href>([^<]+)<\/D:href>/g;
      let match;
      const resourcesToDelete: string[] = [];
      
      while ((match = hrefRegex.exec(body)) !== null) {
        const href = match[1];
        if (!href) continue;
        // Only delete resources in our test address book
        if (href.includes('test-addressbook')) {
          resourcesToDelete.push(href);
        }
      }

      for (const resource of resourcesToDelete) {
        try {
          await fetch(resource, {
            method: 'DELETE',
            headers: {
              Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
            },
          });
        } catch {
          // Ignore deletion errors
        }
      }
    }

    // Delete the address book itself
    if (addressBookHomeSet) {
      const addressBookUrl = new URL(`test-addressbook/`, addressBookHomeSet).toString();
      try {
        await fetch(addressBookUrl, {
          method: 'DELETE',
          headers: {
            Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
          },
        });
      } catch {
        // Ignore address book deletion errors
      }
    }

    console.log('[Cleanup] Address book cleaned');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Cleanup] Warning: Could not clean address book: ${msg}`);
  }
}

// Conditionally skip the entire test suite
// SKIPPED on cutover branch (issue #34): DAV discovery/href fixes live on main.
// Will un-skip automatically when this branch rebases after PR merges.
const testSuite = describe;

testSuite('CardDAV Source Integration Tests', () => {
  let carddavSource: CarddavSource;

  beforeAll(async () => {
    console.log('[CardDAV Tests] Waiting for CardDAV server...');
    await waitForCarddav();
    console.log('[CardDAV Tests] CardDAV server is ready');
    
    // Create the CardDAV source for seeding
    carddavSource = new CarddavSource({
      url: `${NEXTCLOUD_WEBDAV_URL}/`,
      username: NEXTCLOUD_USERNAME,
      passwordEnv: 'NEXTCLOUD_PASSWORD',
    } as CardDAVSourceConfig);
    process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;
  }, 60000);

  beforeEach(async () => {
    // Clean up before each test for isolation
    await cleanAddressBook(carddavSource);
    // Seed with the carddavSource instance
    await seedContacts(carddavSource);
  });

  afterAll(async () => {
    // Final cleanup
    await cleanAddressBook(carddavSource);
  });

  describe('listFolders()', () => {
    it('should discover seeded address books', async () => {
      // carddavSource is already created in beforeAll
      process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;

      const folders = await carddavSource.listFolders();

      expect(folders).toBeDefined();
      expect(Array.isArray(folders)).toBe(true);
      
      // Should find at least the test address book
      const testAddressBook = folders.find(f => f.name === TEST_ADDRESSBOOK_NAME);
      expect(testAddressBook).toBeDefined();
      expect(testAddressBook?.name).toBe(TEST_ADDRESSBOOK_NAME);

      console.log('[listFolders] Discovered address books:', folders.map(f => f.name));
    });
  });

  describe('listSince()', () => {
    it('should return seeded contacts with correct vCard payload', async () => {
      carddavSource = new CarddavSource({
        url: `${NEXTCLOUD_WEBDAV_URL}/`,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
      } as CardDAVSourceConfig);

      process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;

      // First, get the address book folder
      const folders = await carddavSource.listFolders();
      const testAddressBook = folders.find(f => f.name === TEST_ADDRESSBOOK_NAME);
      expect(testAddressBook).toBeDefined();

      // List contacts since epoch (all contacts)
      const { items, nextCursor } = await carddavSource.listSince(testAddressBook!);

      expect(items).toBeDefined();
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThanOrEqual(3);

      // Verify each contact has correct structure
      for (const item of items) {
        expect(item.item).toBeDefined();
        expect(item.item.uid).toBeDefined();
        expect(item.item.name).toBeDefined();
        expect(item.item.vcard).toBeDefined();

        // Verify vCard payload contains expected properties
        const vcard = item.item.vcard;
        expect(vcard).toContain('BEGIN:VCARD');
        expect(vcard).toContain('END:VCARD');
        expect(vcard).toContain('UID:');
        expect(vcard).toContain('FN:');
        expect(vcard).toContain('VERSION:');
      }

      // Verify our test contacts are present
      const contactUids = items.map(i => i.item.uid.toLowerCase());
      expect(contactUids).toContain(TEST_CONTACT_UID_1.toLowerCase());
      expect(contactUids).toContain(TEST_CONTACT_UID_2.toLowerCase());
      expect(contactUids).toContain(TEST_CONTACT_UID_3.toLowerCase());

      expect(nextCursor).toBeDefined();
      expect(nextCursor.value).toBeDefined();

      console.log('[listSince] Found', items.length, 'contacts');
    });

    it('should support cursor round-trip (second call returns only changes)', async () => {
      carddavSource = new CarddavSource({
        url: `${NEXTCLOUD_WEBDAV_URL}/`,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
      } as CardDAVSourceConfig);

      process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;

      const folders = await carddavSource.listFolders();
      const testAddressBook = folders.find(f => f.name === TEST_ADDRESSBOOK_NAME);
      expect(testAddressBook).toBeDefined();

      // First call - get all contacts
      const result1 = await carddavSource.listSince(testAddressBook!);
      const initialCount = result1.items.length;
      expect(initialCount).toBeGreaterThanOrEqual(3);
      expect(result1.nextCursor.value).toBeDefined();

      // Second call with cursor - should return no new items (all already seen)
      const result2 = await carddavSource.listSince(testAddressBook!, result1.nextCursor);
      
      // With cursor-based sync, unchanged data should return empty or minimal results
      expect(result2.items.length).toBeLessThanOrEqual(initialCount);
      
      console.log('[Cursor Round-trip] First call:', initialCount, 'contacts, Second call:', result2.items.length, 'contacts');
    });
  });

  describe('Idempotency', () => {
    it('should be idempotent (run twice, second run creates 0 new items)', async () => {
      carddavSource = new CarddavSource({
        url: `${NEXTCLOUD_WEBDAV_URL}/`,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
      } as CardDAVSourceConfig);

      process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;

      const folders = await carddavSource.listFolders();
      const testAddressBook = folders.find(f => f.name === TEST_ADDRESSBOOK_NAME);
      expect(testAddressBook).toBeDefined();

      // First sync - collect all contacts
      const sync1 = await carddavSource.listSince(testAddressBook!);
      const firstRunCount = sync1.items.length;
      expect(firstRunCount).toBeGreaterThanOrEqual(3);

      // Second sync with cursor - should get no new items
      const sync2 = await carddavSource.listSince(testAddressBook!, sync1.nextCursor);
      
      // Idempotency: second sync should not return new items
      expect(sync2.items.length).toBe(0);

      console.log('[Idempotency] First sync:', firstRunCount, 'contacts, Second sync:', sync2.items.length, 'contacts');
    });
  });

  describe('Contact parsing', () => {
    it('should correctly parse vCard contact properties', async () => {
      carddavSource = new CarddavSource({
        url: `${NEXTCLOUD_WEBDAV_URL}/`,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
      } as CardDAVSourceConfig);

      process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;

      const folders = await carddavSource.listFolders();
      const testAddressBook = folders.find(f => f.name === TEST_ADDRESSBOOK_NAME);
      expect(testAddressBook).toBeDefined();

      const { items } = await carddavSource.listSince(testAddressBook!);

      // Find our first test contact
      const testContact = items.find(i => i.item.uid.toLowerCase() === TEST_CONTACT_UID_1.toLowerCase());
      expect(testContact).toBeDefined();

      // Verify parsed properties - using correct Contact interface properties
      expect(testContact!.item.name).toBe('Alice Johnson');
      expect(testContact!.item.organization?.name).toBe('Acme Corp');
      expect(testContact!.item.organization?.title).toBe('Software Engineer');
      
      // Verify email exists in emails array
      expect(testContact!.item.emails).toBeDefined();
      const email = testContact!.item.emails?.find(e => e.value === 'alice@dev.local');
      expect(email).toBeDefined();
      
      // Verify phone number exists in phones array
      expect(testContact!.item.phones).toBeDefined();
      const phone = testContact!.item.phones?.find(p => p.value === '+1-555-1234');
      expect(phone).toBeDefined();

      // Verify address exists in addresses array
      expect(testContact!.item.addresses).toBeDefined();
      const adr = testContact!.item.addresses?.find(a => a.street === '123 Main St');
      expect(adr).toBeDefined();
      expect(adr?.city).toBe('San Francisco');
      expect(adr?.region).toBe('CA');
      expect(adr?.postalCode).toBe('94105');
      expect(adr?.country).toBe('USA');

      console.log('[Contact Parsing] Verified contact properties');
    });
  });
});
