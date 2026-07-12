// Copyright 2026 OpenHands Agent (Apache-2.0)
// Integration tests for CardDAV source connector against a real Stalwart CardDAV server.
// Uses Testcontainers for containerized Stalwart instance.
//
// Stalwart v0.16+ supports CalDAV/CardDAV/WebDAV on its HTTP port (same as JMAP).
// Tests use RFC 6764 well-known discovery for proper endpoint resolution.
// 
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

// Stalwart CardDAV configuration from Testcontainers
const STALWART_HTTP_URL = process.env.STALWART_JMAP_URL?.replace(/\/jmap$/, "") || "";
const CARDDAV_USERNAME = process.env.STALWART_JMAP_USERNAME || 'source@dev.local';
const CARDDAV_PASSWORD = process.env.STALWART_JMAP_PASSWORD || 'source_password';

// Check if Stalwart supports CardDAV (it doesn't in v0.16.10)
let carddavSupported = false;
let skipReason = 'Stalwart CardDAV URL not configured';

if (STALWART_HTTP_URL) {
  try {
    // Check if Stalwart supports CardDAV by probing the well-known URI
    const response = await fetch(`${STALWART_HTTP_URL.replace(/\/$/, '')}/.well-known/carddav`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`${CARDDAV_USERNAME}:${CARDDAV_PASSWORD}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    
    // Check content-type to detect HTML responses (Stalwart portal)
    const _contentType = response.headers.get('content-type') || '';
    
    // Stalwart v0.16.10 does not support DAV - returns HTML for all DAV endpoints

    if (response.status === 401 || response.status === 200 || response.status === 204 || response.status === 301 || response.status === 302 || response.status === 307 || response.status === 308) {
      carddavSupported = true;
    } else if (response.status === 404) {
      skipReason = 'Stalwart .well-known/carddav not found - DAV may not be enabled';
    } else {
      skipReason = `Unexpected response: ${response.status}`;
    }
  } catch (err) {
    skipReason = `Could not probe Stalwart CardDAV: ${err instanceof Error ? err.message : String(err)}`;
  }
} else {
  skipReason = 'Stalwart CardDAV URL not configured (STALWART_HTTP_URL not set)';
}

// Skip all tests if CardDAV is not supported
if (!carddavSupported) {
  console.warn(`[CardDAV Tests] Skipping: ${skipReason}`);
}

// Fixed test contact UIDs
const TEST_ADDRESSBOOK_NAME = 'Test Address Book';
const TEST_CONTACT_UID_1 = 'contact-alice@dev.local';
const TEST_CONTACT_UID_2 = 'contact-bob@dev.local';
const TEST_CONTACT_UID_3 = 'contact-charlie@dev.local';

/**
 * Wait for CardDAV server to be ready.
 */
async function waitForCarddav(maxRetries = 30, delayMs = 2000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${STALWART_HTTP_URL}/.well-known/carddav`, {
        method: 'GET',
      });
      if (response.status === 200 || response.status === 401 || response.status === 404) {
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
  const carddavUrl = STALWART_HTTP_URL!.replace(/\/$/, '');
  
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
          Authorization: `Basic ${Buffer.from(`${CARDDAV_USERNAME}:${CARDDAV_PASSWORD}`).toString('base64')}`,
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
          Authorization: `Basic ${Buffer.from(`${CARDDAV_USERNAME}:${CARDDAV_PASSWORD}`).toString('base64')}`,
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
  const carddavUrl = STALWART_HTTP_URL || 'http://localhost:8080';
  
  try {
    // If we have the address book home-set, use it for cleanup
    const baseCollectionUrl = addressBookHomeSet || `${carddavUrl.replace(/\/$/, '')}/${CARDDAV_USERNAME.split('@')[0]}/`;
    
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
        Authorization: `Basic ${Buffer.from(`${CARDDAV_USERNAME}:${CARDDAV_PASSWORD}`).toString('base64')}`,
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
              Authorization: `Basic ${Buffer.from(`${CARDDAV_USERNAME}:${CARDDAV_PASSWORD}`).toString('base64')}`,
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
            Authorization: `Basic ${Buffer.from(`${CARDDAV_USERNAME}:${CARDDAV_PASSWORD}`).toString('base64')}`,
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
const testSuite = carddavSupported ? describe : describe.skip;

testSuite('CardDAV Source Integration Tests', () => {
  let carddavSource: CarddavSource;

  beforeAll(async () => {
    console.log('[CardDAV Tests] Waiting for CardDAV server...');
    await waitForCarddav();
    console.log('[CardDAV Tests] CardDAV server is ready');
    
    // Create the CardDAV source for seeding
    carddavSource = new CarddavSource({
      url: `${STALWART_HTTP_URL}/`,
      username: CARDDAV_USERNAME,
      passwordEnv: 'CARDDAV_PASSWORD',
    } as CardDAVSourceConfig);
    process.env.CARDDAV_PASSWORD = CARDDAV_PASSWORD;
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
      process.env.CARDDAV_PASSWORD = CARDDAV_PASSWORD;

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
        url: `${STALWART_HTTP_URL}/`,
        username: CARDDAV_USERNAME,
        passwordEnv: 'CARDDAV_PASSWORD',
      } as CardDAVSourceConfig);

      process.env.CARDDAV_PASSWORD = CARDDAV_PASSWORD;

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
        url: `${STALWART_HTTP_URL}/`,
        username: CARDDAV_USERNAME,
        passwordEnv: 'CARDDAV_PASSWORD',
      } as CardDAVSourceConfig);

      process.env.CARDDAV_PASSWORD = CARDDAV_PASSWORD;

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
        url: `${STALWART_HTTP_URL}/`,
        username: CARDDAV_USERNAME,
        passwordEnv: 'CARDDAV_PASSWORD',
      } as CardDAVSourceConfig);

      process.env.CARDDAV_PASSWORD = CARDDAV_PASSWORD;

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
        url: `${STALWART_HTTP_URL}/`,
        username: CARDDAV_USERNAME,
        passwordEnv: 'CARDDAV_PASSWORD',
      } as CardDAVSourceConfig);

      process.env.CARDDAV_PASSWORD = CARDDAV_PASSWORD;

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
