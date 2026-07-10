/**
 * WebDAV Source Unit Tests
 * 
 * Tests for:
 * - PROPFIND depth-1 parsing
 * - ETag extraction
 * - File metadata parsing
 * - Path normalization
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebdavFileSource } from './webdav-source';
import type { WebDAVSourceConfig, PropfindResponseEntry } from './webdav-source.types';
import type { HttpClient, HttpResponse } from './dav-http.types';

// Test configuration
const testConfig: WebDAVSourceConfig = {
  url: 'https://example.com/webdav',
  username: 'testuser',
  passwordEnv: 'WEBDAV_PASSWORD',
};

// Mock HTTP client for testing
function createMockHttpClient(mockResponse: HttpResponse): HttpClient {
  return {
    request: vi.fn().mockResolvedValue(mockResponse),
  };
}

// Sample PROPFIND response with depth-1 listing
const samplePropfindResponse = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/documents/</D:href>
    <D:status>HTTP/1.1 200 OK</D:status>
    <D:propstat>
      <D:prop>
        <D:displayname>Documents</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:creationdate>2024-01-01T10:00:00Z</D:creationdate>
        <D:getlastmodified>Mon, 15 Jan 2024 14:30:00 GMT</D:getlastmodified>
      </D:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/documents/report.pdf</D:href>
    <D:status>HTTP/1.1 200 OK</D:status>
    <D:propstat>
      <D:prop>
        <D:displayname>report.pdf</D:displayname>
        <D:resourcetype/>
        <D:getcontenttype>application/pdf</D:getcontenttype>
        <D:getcontentlength>1048576</D:getcontentlength>
        <D:getlastmodified>Mon, 15 Jan 2024 12:00:00 GMT</D:getlastmodified>
        <D:getetag>"abc123def456"</D:getetag>
      </D:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/documents/image.png</D:href>
    <D:status>HTTP/1.1 200 OK</D:status>
    <D:propstat>
      <D:prop>
        <D:displayname>image.png</D:displayname>
        <D:resourcetype/>
        <D:getcontenttype>image/png</D:getcontenttype>
        <D:getcontentlength>524288</D:getcontentlength>
        <D:getlastmodified>Tue, 16 Jan 2024 09:15:00 GMT</D:getlastmodified>
        <D:getetag>"xyz789ghi012"</D:getetag>
      </D:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/documents/subfolder/</D:href>
    <D:status>HTTP/1.1 200 OK</D:status>
    <D:propstat>
      <D:prop>
        <D:displayname>Subfolder</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getlastmodified>Wed, 17 Jan 2024 08:00:00 GMT</D:getlastmodified>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`;

// Sample PROPFIND response with weak ETags
const samplePropfindWithWeakEtags = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/files/weak-etag.txt</D:href>
    <D:status>HTTP/1.1 200 OK</D:status>
    <D:propstat>
      <D:prop>
        <D:getetag>W/"weak-etag-123"</D:getetag>
        <D:getcontentlength>1024</D:getcontentlength>
        <D:getlastmodified>Thu, 18 Jan 2024 10:00:00 GMT</D:getlastmodified>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`;

// Sample PROPFIND response with quota information
const samplePropfindWithQuota = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/quota-folder/</D:href>
    <D:status>HTTP/1.1 200 OK</D:status>
    <D:propstat>
      <D:prop>
        <D:displayname>Quota Folder</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
        <Q:quota-used-bytes xmlns:Q="DAV:">1073741824</Q:quota-used-bytes>
        <Q:quota-available-bytes xmlns:Q="DAV:">10737418240</Q:quota-available-bytes>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`;

describe('WebdavFileSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set environment variable for tests
    process.env.WEBDAV_PASSWORD = 'testpassword123';
  });

  describe('PROPFIND depth-1 parsing', () => {
    it('should parse PROPFIND response with multiple entries', async () => {
      const mockClient = createMockHttpClient({
        status: 207,
        body: samplePropfindResponse,
        headers: {},
      });

      const source = new WebdavFileSource(testConfig, { httpClient: mockClient });

      // Access private method via any for testing
      const result = await (source as any).performPropfind('/documents', '1');

      expect(result.responses).toHaveLength(4);
      
      // Check first entry (folder)
      expect(result.responses[0].href).toBe('/documents');
      expect(result.responses[0].displayName).toBe('Documents');
      expect(result.responses[0].resourceType).toContain('collection');

      // Check file entries
      const pdfEntry = result.responses.find((r: PropfindResponseEntry) => r.href === '/documents/report.pdf');
      expect(pdfEntry).toBeDefined();
      expect(pdfEntry?.getContentType).toBe('application/pdf');
      expect(pdfEntry?.getContentLength).toBe(1048576);
    });

    it('should handle PROPFIND response with only folders', async () => {
      const onlyFoldersResponse = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/folder1/</D:href>
    <D:status>HTTP/1.1 200 OK</D:status>
    <D:propstat>
      <D:prop>
        <D:displayname>Folder 1</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/folder2/</D:href>
    <D:status>HTTP/1.1 200 OK</D:status>
    <D:propstat>
      <D:prop>
        <D:displayname>Folder 2</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`;

      const mockClient = createMockHttpClient({
        status: 207,
        body: onlyFoldersResponse,
        headers: {},
      });

      const source = new WebdavFileSource(testConfig, { httpClient: mockClient });
      const result = await (source as any).performPropfind('/', '1');

      expect(result.responses).toHaveLength(2);
      expect(result.responses[0].resourceType).toContain('collection');
      expect(result.responses[1].resourceType).toContain('collection');
    });

    it('should handle PROPFIND response with only files', async () => {
      const onlyFilesResponse = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/file1.txt</D:href>
    <D:status>HTTP/1.1 200 OK</D:status>
    <D:propstat>
      <D:prop>
        <D:displayname>file1.txt</D:displayname>
        <D:getcontentlength>100</D:getcontentlength>
        <D:getetag>"file1-etag"</D:getetag>
      </D:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/file2.txt</D:href>
    <D:status>HTTP/1.1 200 OK</D:status>
    <D:propstat>
      <D:prop>
        <D:displayname>file2.txt</D:displayname>
        <D:getcontentlength>200</D:getcontentlength>
        <D:getetag>"file2-etag"</D:getetag>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`;

      const mockClient = createMockHttpClient({
        status: 207,
        body: onlyFilesResponse,
        headers: {},
      });

      const source = new WebdavFileSource(testConfig, { httpClient: mockClient });
      const result = await (source as any).performPropfind('/', '1');

      expect(result.responses).toHaveLength(2);
      expect(result.responses[0].resourceType).toContain('resource');
      expect(result.responses[1].resourceType).toContain('resource');
    });
  });

  describe('ETag extraction', () => {
    it('should extract strong ETag with quotes', async () => {
      const mockClient = createMockHttpClient({
        status: 207,
        body: samplePropfindResponse,
        headers: {},
      });

      const source = new WebdavFileSource(testConfig, { httpClient: mockClient });
      const result = await (source as any).performPropfind('/documents', '1');

      const pdfEntry = result.responses.find((r: PropfindResponseEntry) => r.href === '/documents/report.pdf');
      expect(pdfEntry?.getEtag).toBe('"abc123def456"');
    });

    it('should extract weak ETag', async () => {
      const mockClient = createMockHttpClient({
        status: 207,
        body: samplePropfindWithWeakEtags,
        headers: {},
      });

      const source = new WebdavFileSource(testConfig, { httpClient: mockClient });
      const result = await (source as any).performPropfind('/files', '1');

      const entry = result.responses[0];
      expect(entry?.getEtag).toBe('W/"weak-etag-123"');
    });

    it('should clean ETag by removing quotes', () => {
      const source = new WebdavFileSource(testConfig);
      
      // Access private method via any for testing
      const cleanEtag = (source as any).cleanEtag;
      
      expect(cleanEtag('"abc123"')).toBe('abc123');
      expect(cleanEtag('W/"weak-etag"')).toBe('W/"weak-etag"'); // Weak ETag prefix preserved
      expect(cleanEtag('simple-etag')).toBe('simple-etag');
      expect(cleanEtag('')).toBe('');
      expect(cleanEtag('  "spaced-etag"  ')).toBe('spaced-etag');
    });
  });

  describe('File metadata parsing', () => {
    it('should parse file with all metadata fields', async () => {
      const mockClient = createMockHttpClient({
        status: 207,
        body: samplePropfindResponse,
        headers: {},
      });

      const source = new WebdavFileSource(testConfig, { httpClient: mockClient });
      const result = await (source as any).performPropfind('/documents', '1');

      const pdfEntry = result.responses.find((r: PropfindResponseEntry) => r.href === '/documents/report.pdf');
      const file = (source as any).parseFileFromEntry(pdfEntry);

      expect(file).toBeDefined();
      expect(file.path).toBe('/documents/report.pdf');
      expect(file.name).toBe('report.pdf');
      expect(file.size).toBe(1048576);
      expect(file.mimeType).toBe('application/pdf');
      expect(file.etag).toBe('abc123def456'); // Cleaned ETag
      expect(file.resourceType).toBe('file');
    });

    it('should parse file with minimal metadata', () => {
      const source = new WebdavFileSource(testConfig);
      
      const minimalEntry: any = {
        href: '/minimal.txt',
        status: 'HTTP/1.1 200 OK',
        resourceType: ['resource'],
      };

      const file = (source as any).parseFileFromEntry(minimalEntry);
      
      expect(file).toBeDefined();
      expect(file.path).toBe('/minimal.txt');
      expect(file.name).toBe('minimal.txt');
      expect(file.size).toBe(0);
      expect(file.etag).toBe('');
    });

    it('should parse folder with quota information', async () => {
      const mockClient = createMockHttpClient({
        status: 207,
        body: samplePropfindWithQuota,
        headers: {},
      });

      const source = new WebdavFileSource(testConfig, { httpClient: mockClient });
      const result = await (source as any).performPropfind('/quota-folder', '0');

      const folderEntry = result.responses[0];
      const folder = (source as any).parseFolderFromEntry(folderEntry);

      expect(folder).toBeDefined();
      expect(folder.path).toBe('/quota-folder');
      expect(folder.name).toBe('Quota Folder');
      expect(folder.quota).toBeDefined();
      expect(folder.quota?.used).toBe(1073741824);
      expect(folder.quota?.available).toBe(10737418240);
    });

    it('should parse file creation date', () => {
      const source = new WebdavFileSource(testConfig);
      
      const entry: any = {
        href: '/created-file.txt',
        status: 'HTTP/1.1 200 OK',
        resourceType: ['resource'],
        getCreated: '2024-01-01T12:00:00Z',
        getLastModified: 'Mon, 15 Jan 2024 14:30:00 GMT',
        getEtag: '"file-etag"',
      };

      const file = (source as any).parseFileFromEntry(entry);
      
      expect(file.createdAt).toBe('2024-01-01T12:00:00.000Z');
      expect(file.modifiedAt).toBe('2024-01-15T14:30:00.000Z');
    });
  });

  describe('Path normalization', () => {
    it('should normalize paths with backslashes', () => {
      const source = new WebdavFileSource(testConfig);
      
      // Access private method via any for testing
      const normalizePath = (source as any).normalizePath;
      
      expect(normalizePath('\\documents\\files')).toBe('/documents/files');
      expect(normalizePath('documents\\files')).toBe('/documents/files');
    });

    it('should ensure leading slash', () => {
      const source = new WebdavFileSource(testConfig);
      const normalizePath = (source as any).normalizePath;
      
      expect(normalizePath('documents')).toBe('/documents');
      expect(normalizePath('documents/files')).toBe('/documents/files');
    });

    it('should remove trailing slashes except for root', () => {
      const source = new WebdavFileSource(testConfig);
      const normalizePath = (source as any).normalizePath;
      
      expect(normalizePath('/documents/')).toBe('/documents');
      expect(normalizePath('/documents/files/')).toBe('/documents/files');
      expect(normalizePath('/')).toBe('/');
    });

    it('should handle multiple consecutive slashes', () => {
      const source = new WebdavFileSource(testConfig);
      const normalizePath = (source as any).normalizePath;
      
      expect(normalizePath('//documents//files')).toBe('/documents/files');
      expect(normalizePath('/documents///files')).toBe('/documents/files');
    });

    it('should handle empty and root paths', () => {
      const source = new WebdavFileSource(testConfig);
      const normalizePath = (source as any).normalizePath;
      
      expect(normalizePath('')).toBe('/');
      expect(normalizePath('/')).toBe('/');
    });
  });

  describe('listFolders', () => {
    it('should list folders from PROPFIND response', async () => {
      const mockClient = createMockHttpClient({
        status: 207,
        body: samplePropfindResponse,
        headers: {},
      });

      const source = new WebdavFileSource(testConfig, { httpClient: mockClient });
      const folders = await source.listFolders();

      // Should find 2 folders (Documents and subfolder)
      const collections = folders.filter(f => f.path.includes('folder') || f.path.includes('Documents'));
      expect(collections.length).toBeGreaterThan(0);
    });

    it('should use rootPath from config', async () => {
      const configWithRoot: WebDAVSourceConfig = {
        ...testConfig,
        rootPath: '/custom-root',
      };

      const mockClient = createMockHttpClient({
        status: 207,
        body: samplePropfindResponse,
        headers: {},
      });

      const source = new WebdavFileSource(configWithRoot, { httpClient: mockClient });
      
      // The performPropfind should be called with the custom root path
      await source.listFolders();
      
      expect(mockClient.request).toHaveBeenCalled();
    });
  });

  describe('listSince', () => {
    it('should return all items when no cursor provided', async () => {
      const mockClient = createMockHttpClient({
        status: 207,
        body: samplePropfindResponse,
        headers: {},
      });

      // Also mock the fetchFileContent method
      const source = new WebdavFileSource(testConfig, { httpClient: mockClient });
      (source as any).fetchFileContent = vi.fn().mockResolvedValue(new Uint8Array());

      const folder = { path: '/documents', name: 'Documents' };
      const result = await source.listSince(folder);

      expect(result.items).toHaveLength(2); // Only files, not folders
      expect(result.nextCursor.value).toBeTruthy();
    });

    it('should filter unchanged files based on cursor', async () => {
      // Create a cursor with existing ETags
      const cursorData = {
        folder: '/documents',
        etags: {
          '/documents/report.pdf': 'abc123def456', // Same as in response
          '/documents/image.png': 'different-etag', // Different from response
        },
        sizes: {
          '/documents/report.pdf': 1048576,
          '/documents/image.png': 524288,
        },
        mtimes: {
          '/documents/report.pdf': '2024-01-15T12:00:00.000Z',
          '/documents/image.png': '2024-01-16T09:15:00.000Z',
        },
      };
      const cursor = {
        value: Buffer.from(JSON.stringify(cursorData)).toString('base64'),
      };

      const mockClient = createMockHttpClient({
        status: 207,
        body: samplePropfindResponse,
        headers: {},
      });

      const source = new WebdavFileSource(testConfig, { httpClient: mockClient });
      (source as any).fetchFileContent = vi.fn().mockResolvedValue(new Uint8Array());

      const folder = { path: '/documents', name: 'Documents' };
      const result = await source.listSince(folder, cursor);

      // report.pdf should be filtered out (unchanged)
      // image.png should be included (changed)
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.item.path).toBe('/documents/image.png');
    });
  });

  describe('Authorization header', () => {
    it('should create Basic auth header from password env variable', () => {
      process.env.WEBDAV_PASSWORD = 'testpassword';
      
      const source = new WebdavFileSource(testConfig);
      
      // Access private method via any for testing
      const getAuthHeader = (source as any).getAuthorizationHeader.bind(source);
      
      const header = getAuthHeader();
      expect(header).toMatch(/^Basic /);
      
      // Decode and verify credentials
      const base64Part = header.replace('Basic ', '');
      const decoded = Buffer.from(base64Part, 'base64').toString('utf-8');
      expect(decoded).toBe('testuser:testpassword');
    });

    it('should throw error if password env variable not set', () => {
      delete process.env.WEBDAV_PASSWORD;
      
      const source = new WebdavFileSource(testConfig);
      
      const getAuthHeader = (source as any).getAuthorizationHeader.bind(source);
      
      expect(() => getAuthHeader()).toThrow('Password environment variable WEBDAV_PASSWORD not set');
    });
  });

  describe('URL building', () => {
    it('should build correct URL from base and path', () => {
      const source = new WebdavFileSource(testConfig);
      
      // Access private method via any for testing
      const buildUrl = (source as any).buildUrl.bind(source);
      
      expect(buildUrl('/documents')).toBe('https://example.com/webdav/documents');
      expect(buildUrl('/documents/files')).toBe('https://example.com/webdav/documents/files');
      expect(buildUrl('')).toBe('https://example.com/webdav');
    });

    it('should handle base URL with trailing slash', () => {
      const configWithTrailingSlash: WebDAVSourceConfig = {
        ...testConfig,
        url: 'https://example.com/webdav/',
      };
      
      const source = new WebdavFileSource(configWithTrailingSlash);
      const buildUrl = (source as any).buildUrl.bind(source);
      
      expect(buildUrl('/documents')).toBe('https://example.com/webdav/documents');
    });
  });

  describe('Date parsing', () => {
    it('should parse RFC 1123 date format', () => {
      const source = new WebdavFileSource(testConfig);
      
      // Access private method via any for testing
      const parseDate = (source as any).parseDate.bind(source);
      
      const result = parseDate('Mon, 15 Jan 2024 14:30:00 GMT');
      expect(result).toBe('2024-01-15T14:30:00.000Z');
    });

    it('should parse ISO 8601 date format', () => {
      const source = new WebdavFileSource(testConfig);
      const parseDate = (source as any).parseDate.bind(source);
      
      const result = parseDate('2024-01-15T14:30:00Z');
      expect(result).toBe('2024-01-15T14:30:00.000Z');
    });
  });

  describe('Name extraction from path', () => {
    it('should extract file name from path', () => {
      const source = new WebdavFileSource(testConfig);
      
      // Access private method via any for testing
      const extractNameFromPath = (source as any).extractNameFromPath.bind(source);
      
      expect(extractNameFromPath('/documents/report.pdf')).toBe('report.pdf');
      expect(extractNameFromPath('/documents/subfolder/image.png')).toBe('image.png');
      expect(extractNameFromPath('/file.txt')).toBe('file.txt');
    });

    it('should handle paths with trailing slashes', () => {
      const source = new WebdavFileSource(testConfig);
      const extractNameFromPath = (source as any).extractNameFromPath.bind(source);
      
      expect(extractNameFromPath('/documents/')).toBe('documents');
      expect(extractNameFromPath('/documents/subfolder/')).toBe('subfolder');
    });
  });
});
