/**
 * Graph Contacts Source Unit Tests
 * 
 * Tests for GraphContactsSource implementation covering:
 * - Contact folder enumeration via /me/contactFolders
 * - Delta query with @odata.deltaLink
 * - Graph contact → vCard 4.0 field mapping
 * - Photo handling with BASE64 encoding
 * - UID mapping (Graph id as fallback when vCard UID is absent)
 * - Multi-value field handling (emails, phones, addresses)
 * - Delta chaining for incremental sync
 */

import { describe, it, expect, vi } from 'vitest';
import { GraphContactsSource } from './graph-contacts-source';
import type { GraphContactsSourceConfig as _GraphContactsSourceConfig } from './graph-contacts-source.types';
import type { HttpClient, HttpResponse } from './dav-http.types';
import type { TokenProvider, OAuth2Token } from '@openmig/shared';

// Mock token provider
function createMockTokenProvider(token: OAuth2Token = defaultToken): TokenProvider {
  return {
    getToken: vi.fn().mockResolvedValue(token),
    refresh: vi.fn().mockResolvedValue(token),
    isTokenValid: vi.fn().mockReturnValue(true),
    getTokenStatus: vi.fn().mockReturnValue({ isValid: true, timeUntilExpiry: 3600 }),
  };
}

const defaultToken: OAuth2Token = {
  accessToken: 'mock-access-token',
  tokenType: 'Bearer',
  expiresAt: Date.now() + 3600000,
};

// Mock HTTP client
function createMockHttpClient(responses: HttpResponse[]): HttpClient {
  let callCount = 0;
  return {
    request: vi.fn().mockImplementation(() => {
      const response = responses[callCount] || responses[responses.length - 1];
      callCount++;
      return Promise.resolve(response);
    }),
  };
}

describe('GraphContactsSource', () => {
  describe('Contact folder enumeration', () => {
    it('should list all contact folders from /me/contactFolders endpoint', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'AQMkAGI2-contact-folder',
                name: 'Contacts',
                parentFolderId: 'root',
                totalItemCount: 15,
                unreadItemCount: 0,
                childFolderCount: 0,
              },
              {
                id: 'AQMkAGI3-people-folder',
                name: 'People',
                parentFolderId: 'root',
                totalItemCount: 8,
                unreadItemCount: 2,
                childFolderCount: 0,
              },
            ],
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folders = await source.listFolders();

      expect(folders).toHaveLength(2);
      expect(folders[0]).toMatchObject({
        path: '/contactFolders/AQMkAGI2-contact-folder',
        name: 'Contacts',
        supportedVersions: ['4.0'],
      });
      expect(folders[1]).toMatchObject({
        path: '/contactFolders/AQMkAGI3-people-folder',
        name: 'People',
        supportedVersions: ['4.0'],
      });
    });

    it('should handle pagination for contact folder list', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'folder1',
                name: 'Primary Contacts',
                totalItemCount: 100,
              },
            ],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/contactFolders?$skip=1',
          }),
          headers: {},
        },
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'folder2',
                name: 'Secondary Contacts',
                totalItemCount: 50,
              },
            ],
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folders = await source.listFolders();

      expect(folders).toHaveLength(2);
      expect(mockClient.request).toHaveBeenCalledTimes(2);
    });

    it('should handle empty contact folder list', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({ value: [] }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folders = await source.listFolders();

      expect(folders).toHaveLength(0);
    });
  });

  describe('Delta query', () => {
    it('should perform initial delta query without cursor', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-001',
                displayName: 'John Doe',
                givenName: 'John',
                surname: 'Doe',
                jobTitle: 'Software Engineer',
                companyName: 'Acme Corp',
                businessPhones: ['+1 555-1234'],
                mobilePhone: '+1 555-5678',
                emailAddresses: [
                  { address: 'john.doe@example.com', name: 'John Doe', type: 'work' },
                ],
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=abc123',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/contact-001', name: 'Contacts' };
      const result = await source.listSince(folder);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.item!.uid).toBe('contact-001');
      expect(result.nextCursor.value).toContain('graph-contacts-delta:');
      expect(result.nextCursor.value).toContain('abc123');
    });

    it('should perform incremental sync with deltaLink cursor', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-002',
                displayName: 'Jane Smith',
                givenName: 'Jane',
                surname: 'Smith',
                businessPhones: ['+1 555-9999'],
                emailAddresses: [
                  { address: 'jane.smith@example.com', type: 'work' },
                ],
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=xyz789',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/contact-001', name: 'Contacts' };
      const cursor = {
        value: 'graph-contacts-delta:/contactFolders/contact-001:https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=abc123',
      };

      const result = await source.listSince(folder, cursor);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.item!.uid).toBe('contact-002');
      expect(result.nextCursor.value).toContain('xyz789');
    });

    it('should handle pagination in delta query', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-001',
                displayName: 'Contact 1',
                givenName: 'First',
                surname: 'One',
                emailAddresses: [{ address: 'contact1@example.com', type: 'work' }],
              },
            ],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/contacts?$skip=1',
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=abc123',
          }),
          headers: {},
        },
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-002',
                displayName: 'Contact 2',
                givenName: 'Second',
                surname: 'Two',
                emailAddresses: [{ address: 'contact2@example.com', type: 'work' }],
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=abc123',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/contact-001', name: 'Contacts' };
      const result = await source.listSince(folder);

      expect(result.items).toHaveLength(2);
      expect(mockClient.request).toHaveBeenCalledTimes(2);
    });

    it('should handle delta chaining (multiple incremental syncs)', async () => {
      const tokenProvider = createMockTokenProvider();

      // First sync
      const mockClient1 = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-001',
                displayName: 'John Doe',
                givenName: 'John',
                surname: 'Doe',
                emailAddresses: [{ address: 'john@example.com', type: 'work' }],
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=delta1',
          }),
          headers: {},
        },
      ]);

      const source1 = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient1 },
      );

      const folder = { path: '/contactFolders/contact-001', name: 'Contacts' };
      const result1 = await source1.listSince(folder);
      
      expect(result1.items).toHaveLength(1);
      expect(result1.items[0]!.item.uid).toBe('contact-001');

      // Second sync with delta token from first
      const mockClient2 = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-002',
                displayName: 'Jane Smith',
                givenName: 'Jane',
                surname: 'Smith',
                emailAddresses: [{ address: 'jane@example.com', type: 'work' }],
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=delta2',
          }),
          headers: {},
        },
      ]);

      const source2 = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient2 },
      );

      const result2 = await source2.listSince(folder, result1.nextCursor);
      
      expect(result2.items).toHaveLength(1);
      expect(result2.items[0]!.item.uid).toBe('contact-002');
      expect(result2.nextCursor.value).toContain('delta2');
    });
  });

  describe('Graph contact → vCard 4.0 mapping', () => {
    it('should map basic contact fields to vCard 4.0', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-001',
                displayName: 'John Doe',
                givenName: 'John',
                surname: 'Doe',
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      expect(result.items).toHaveLength(1);
      const vcard = result.items[0]!.vcard;
      
      expect(vcard).toContain('BEGIN:VCARD');
      expect(vcard).toContain('VERSION:4.0');
      expect(vcard).toContain('UID:contact-001');
      expect(vcard).toContain('FN:John Doe');
      expect(vcard).toContain('N:Doe;John;;;');
      expect(vcard).toContain('END:VCARD');
    });

    it('should map organization fields to vCard ORG property', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-002',
                displayName: 'Jane Smith',
                givenName: 'Jane',
                surname: 'Smith',
                jobTitle: 'Senior Engineer',
                companyName: 'Acme Corp',
                department: 'Engineering',
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      const vcard = result.items[0]!.vcard;
      
      expect(vcard).toContain('ORG:Acme Corp;Engineering');
      expect(vcard).toContain('TITLE:Senior Engineer');
    });

    it('should map note to vCard NOTE property', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-003',
                displayName: 'Bob Wilson',
                personalNotes: 'Met at conference 2024',
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      const vcard = result.items[0]!.vcard;
      
      expect(vcard).toContain('NOTE:Met at conference 2024');
    });

    it('should map birthday to vCard BDAY property', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-004',
                displayName: 'Alice Brown',
                birthday: '1990-05-15',
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      const vcard = result.items[0]!.vcard;
      
      expect(vcard).toContain('BDAY:1990-05-15');
    });

    it('should map categories to vCard CATEGORIES property', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-005',
                displayName: 'Charlie Green',
                categories: ['VIP', 'Customer', 'Tech'],
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      const vcard = result.items[0]!.vcard;
      
      expect(vcard).toContain('CATEGORIES:VIP,Customer,Tech');
    });
  });

    it('should include photo in vCard when available', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-with-photo',
                displayName: 'Photo Contact',
                givenName: 'Photo',
                surname: 'Contact',
                // Photo metadata in the listing, but actual photo data fetched separately
                photo: {
                  id: 'photo-id',
                  height: 64,
                  width: 64,
                },
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
        // Photo data fetched via fetch() method
        {
          status: 200,
          body: Buffer.from('fake-image-data').toString('base64'),
          headers: { 'content-type': 'image/jpeg' },
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      
      // listSince returns metadata-only (no photo)
      const result = await source.listSince(folder);

      expect(result.items).toHaveLength(1);
      // Photo is NOT fetched in listSince - it's undefined
      expect(result.items[0]!.item.photo).toBeUndefined();

      // Fetch the contact with photo via fetch() method
      const fetched = await source.fetch(result.items[0]!.item);

      // Now photo should be present
      expect(fetched.item.photo).toBeDefined();
      expect(fetched.item.photo?.data).toBe(Buffer.from('fake-image-data').toString('base64'));
      expect(fetched.item.photo?.mimeType).toBe('image/jpeg');
      expect(fetched.vcard).toContain('PHOTO;ENCODING=base64;TYPE=image/jpeg:');
    });

  describe('UID mapping (Graph id as fallback)', () => {
    it('should use Graph id as vCard UID', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'graph-contact-id-12345',
                displayName: 'Test Contact',
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.item!.uid).toBe('graph-contact-id-12345');
      expect(result.items[0]!.vcard).toContain('UID:graph-contact-id-12345');
    });

    it('should ensure each contact has a unique UID from Graph id', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-uid-001',
                displayName: 'Contact One',
              },
              {
                id: 'contact-uid-002',
                displayName: 'Contact Two',
              },
              {
                id: 'contact-uid-003',
                displayName: 'Contact Three',
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      expect(result.items).toHaveLength(3);
      expect(result.items[0]!.item!.uid).toBe('contact-uid-001');
      expect(result.items[1]!.item.uid).toBe('contact-uid-002');
      expect(result.items[2]!.item.uid).toBe('contact-uid-003');
    });
  });

  describe('Multi-email handling', () => {
    it('should map multiple email addresses to vCard EMAIL properties', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-multi-email',
                displayName: 'Multi Email Contact',
                emailAddresses: [
                  { address: 'work@example.com', name: 'Work Email', type: 'work' },
                  { address: 'home@example.com', name: 'Home Email', type: 'home' },
                  { address: 'other@example.com', type: 'other' },
                ],
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      const vcard = result.items[0]!.vcard;
      const item = result.items[0]!.item;
      
      expect(vcard).toContain('EMAIL;TYPE=work:work@example.com');
      expect(vcard).toContain('EMAIL;TYPE=home:home@example.com');
      expect(vcard).toContain('EMAIL;TYPE=other:other@example.com');
      
      expect(item.emails).toHaveLength(3);
      expect(item.emails![0]!.value).toBe('work@example.com');
      expect(item.emails![0]!.type).toBe('work');
      expect(item.emails![1]!.value).toBe('home@example.com');
      expect(item.emails![1]!.type).toBe('home');
      expect(item.emails![2]!.value).toBe('other@example.com');
      expect(item.emails![2]!.type).toBe('other');
    });

    it('should handle single email address', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-single-email',
                displayName: 'Single Email Contact',
                emailAddresses: [
                  { address: 'single@example.com', type: 'work' },
                ],
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      const vcard = result.items[0]!.vcard;
      
      expect(vcard).toContain('EMAIL;TYPE=work:single@example.com');
    });
  });

  describe('Multi-phone handling', () => {
    it('should map multiple phone numbers to vCard TEL properties', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-multi-phone',
                displayName: 'Multi Phone Contact',
                businessPhones: ['+1 555-1000', '+1 555-1001'],
                mobilePhone: '+1 555-2000',
                homePhones: ['+1 555-3000'],
                otherPhones: ['+1 555-4000'],
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      const vcard = result.items[0]!.vcard;
      const item = result.items[0]!.item;
      
      expect(vcard).toContain('TEL;TYPE=work:+1 555-1000');
      expect(vcard).toContain('TEL;TYPE=work:+1 555-1001');
      expect(vcard).toContain('TEL;TYPE=cell:+1 555-2000');
      expect(vcard).toContain('TEL;TYPE=home:+1 555-3000');
      expect(vcard).toContain('TEL;TYPE=other:+1 555-4000');
      
      expect(item.phones).toHaveLength(5);
      expect(item.phones![0]!.value).toBe('+1 555-1000');
      expect(item.phones![0]!.type).toBe('work');
      expect(item.phones![1]!.value).toBe('+1 555-1001');
      expect(item.phones![1]!.type).toBe('work');
      expect(item.phones![2]!.value).toBe('+1 555-2000');
      expect(item.phones![2]!.type).toBe('mobile');
      expect(item.phones![3]!.value).toBe('+1 555-3000');
      expect(item.phones![3]!.type).toBe('home');
      expect(item.phones![4]!.value).toBe('+1 555-4000');
      expect(item.phones![4]!.type).toBe('other');
    });

    it('should handle single phone number', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-single-phone',
                displayName: 'Single Phone Contact',
                mobilePhone: '+1 555-5000',
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      const vcard = result.items[0]!.vcard;
      
      expect(vcard).toContain('TEL;TYPE=cell:+1 555-5000');
    });
  });

  describe('Multi-address handling', () => {
    it('should map multiple addresses to vCard ADR properties', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-multi-address',
                displayName: 'Multi Address Contact',
                businessAddress: {
                  street: '123 Business St',
                  city: 'Business City',
                  state: 'BC',
                  postalCode: '12345',
                  countryOrRegion: 'USA',
                },
                homeAddress: {
                  street: '456 Home Ave',
                  city: 'Home Town',
                  state: 'HT',
                  postalCode: '67890',
                  countryOrRegion: 'USA',
                },
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      const vcard = result.items[0]!.vcard;
      const item = result.items[0]!.item;
      
      expect(vcard).toContain('ADR;TYPE=work:;;123 Business St;Business City;BC;12345;USA');
      expect(vcard).toContain('ADR;TYPE=home:;;456 Home Ave;Home Town;HT;67890;USA');
      
      expect(item.addresses).toHaveLength(2);
      expect(item.addresses![0]!.type).toBe('work');
      expect(item.addresses![0]!.city).toBe('Business City');
      expect(item.addresses![1]!.type).toBe('home');
      expect(item.addresses![1]!.city).toBe('Home Town');
    });
  });

  describe('URL handling', () => {
    it('should map websites to vCard URL properties', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-with-urls',
                displayName: 'URL Contact',
                websites: [
                  { address: 'https://example.com', type: 'work' },
                  { address: 'https://linkedin.com/in/user', type: 'profile' },
                  { address: 'https://personal.com', type: 'other' },
                ],
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      const vcard = result.items[0]!.vcard;
      const item = result.items[0]!.item;
      
      expect(vcard).toContain('URL;TYPE=work:https://example.com');
      expect(vcard).toContain('URL;TYPE=profile:https://linkedin.com/in/user');
      expect(vcard).toContain('URL;TYPE=other:https://personal.com');
      
      expect(item.urls).toHaveLength(3);
    });
  });

  describe('Cursor encoding and decoding', () => {
    it('should encode and decode Graph contacts delta cursor', () => {
      const source = new GraphContactsSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const cursor: any = {
        deltaLink: 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=abc123',
        folderPath: '/contactFolders/test',
      };

      const encoded = (source as any).encodeCursor(cursor);
      const decoded = (source as any).decodeCursor({ value: encoded });

      expect(decoded.deltaLink).toBe(cursor.deltaLink);
      expect(decoded.folderPath).toBe(cursor.folderPath);
    });

    it('should handle deltaLink with special characters', () => {
      const source = new GraphContactsSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const cursor: any = {
        deltaLink: 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=abc123&$deltastate=xyz',
        folderPath: '/contactFolders/test',
      };

      const encoded = (source as any).encodeCursor(cursor);
      const decoded = (source as any).decodeCursor({ value: encoded });

      expect(decoded.deltaLink).toBe(cursor.deltaLink);
    });

    it('should throw error for invalid cursor format', () => {
      const source = new GraphContactsSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      expect(() => (source as any).decodeCursor({ value: 'invalid-format' })).toThrow();
    });
  });

  describe('Folder ID extraction', () => {
    it('should extract folder ID from folder path', async () => {
      const source = new GraphContactsSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const folder = { path: '/contactFolders/AQMkAGI2', name: 'Contacts' };
      const folderId = (source as any).extractFolderIdFromFolder(folder);

      expect(folderId).toBe('AQMkAGI2');
    });

    it('should fallback to folder name if path doesn\'t contain folder ID', async () => {
      const source = new GraphContactsSource(
        createMockTokenProvider(),
        'test-tenant-id',
      );

      const folder = { path: '/some/other/path', name: 'MyContacts' };
      const folderId = (source as any).extractFolderIdFromFolder(folder);

      expect(folderId).toBe('MyContacts');
    });
  });

  describe('Error handling', () => {
    it('should throw error when contact folder listing fails', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 500,
          body: 'Internal Server Error',
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      await expect(source.listFolders()).rejects.toThrow('Failed to list contact folders');
    });

    it('should throw error when contact listing fails', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 401,
          body: 'Unauthorized',
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      await expect(source.listSince(folder)).rejects.toThrow('Failed to list contacts');
    });

    it('should skip contacts that fail to process', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-001',
                displayName: 'Valid Contact',
                emailAddresses: [{ address: 'valid@example.com', type: 'work' }],
              },
              {
                id: 'contact-002',
                displayName: 'Invalid Contact',
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      // Should have at least one valid contact
      expect(result.items.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Custom base URL', () => {
    it('should use custom base URL when provided', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({ value: [] }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        { baseUrl: 'https://graph.contoso.com/v1.0' },
        { httpClient: mockClient },
      );

      await source.listFolders();

      const callArgs = (mockClient.request as any).mock.calls[0][0];
      expect(callArgs.url).toContain('https://graph.contoso.com/v1.0');
    });
  });

  describe('vCard escaping', () => {
    it('should escape special characters in vCard values', async () => {
      const tokenProvider = createMockTokenProvider();
      const mockClient = createMockHttpClient([
        {
          status: 200,
          body: JSON.stringify({
            value: [
              {
                id: 'contact-escaped',
                displayName: 'Contact; with, special\ncharacters',
                givenName: 'Test',
                surname: 'Name',
                personalNotes: 'Note with ; semicolon, comma, and\nnewline',
              },
            ],
            '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta',
          }),
          headers: {},
        },
      ]);

      const source = new GraphContactsSource(
        tokenProvider,
        'test-tenant-id',
        undefined,
        { httpClient: mockClient },
      );

      const folder = { path: '/contactFolders/test', name: 'Contacts' };
      const result = await source.listSince(folder);

      const vcard = result.items[0]!.vcard;
      
      // Special characters should be escaped
      expect(vcard).toContain('FN:Contact\\; with\\, special\\ncharacters');
      expect(vcard).toContain('NOTE:Note with \\; semicolon\\, comma\\, and\\nnewline');
    });
  });
});
