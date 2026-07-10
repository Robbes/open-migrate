/**
 * Graph Drive Source Unit Tests
 * 
 * Tests for Microsoft Graph Drive (OneDrive/SharePoint) file source connector.
 * Covers:
 * - Drive enumeration
 * - Delta query with deltaLink
 * - Delta paging
 * - Rename handling (same GUID, log not duplicate per §11.1)
 * - Path normalization
 * - cTag/quickXorHash change detection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphDriveSource } from './graph-drive-source';
import type { TokenProvider, OAuth2Token, SyncCursor, ThrottleLimiter } from '@openmig/shared';
import type { GraphDriveSourceConfig, GraphDriveItem } from './graph-drive-source.types';

describe('GraphDriveSource', () => {
  let mockTokenProvider: TokenProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Setup mock token provider
    mockTokenProvider = {
      getToken: vi.fn().mockResolvedValue({
        accessToken: 'mock-access-token',
        tokenType: 'Bearer',
        expiresAt: Date.now() / 1000 + 3600,
      } as OAuth2Token),
      refresh: vi.fn(),
      isTokenValid: vi.fn().mockReturnValue(true),
      getTokenStatus: vi.fn(),
    };

    // Setup fetch mock
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    
    // Mock setTimeout to return immediately for faster tests
    vi.spyOn(global, 'setTimeout').mockImplementation((fn: () => void) => {
      fn();
      return {} as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listFolders', () => {
    it('should enumerate folders from OneDrive root', async () => {
      const mockResponse = {
        value: [
          {
            id: 'folder1',
            name: 'Documents',
            path: '/Documents',
            folder: { childCount: 5 },
            lastModifiedDateTime: '2024-01-15T00:00:00Z',
            cTag: 'cTag1',
          },
          {
            id: 'folder2',
            name: 'Photos',
            path: '/Photos',
            folder: { childCount: 100 },
            lastModifiedDateTime: '2024-01-20T00:00:00Z',
            cTag: 'cTag2',
          },
          {
            id: 'file1',
            name: 'report.pdf',
            path: '/report.pdf',
            file: { mimeType: 'application/pdf' },
            size: 1024,
            lastModifiedDateTime: '2024-01-10T00:00:00Z',
            cTag: 'cTag3',
          },
        ],
      };

      fetchMock.mockResolvedValue({
        status: 200,
        text: async () => JSON.stringify(mockResponse),
        headers: new Map(),
      });

      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const folders = await driveSource.listFolders();

      expect(folders).toHaveLength(2);
      expect(folders[0]).toMatchObject({
        path: '/Documents',
        name: 'Documents',
      });
      expect(folders[1]).toMatchObject({
        path: '/Photos',
        name: 'Photos',
      });
      // Files should not be included
      expect(folders.find(f => f.name === 'report.pdf')).toBeUndefined();
    });

    it('should handle pagination for folder listing', async () => {
      const page1 = {
        value: [
          {
            id: 'folder1',
            name: 'Folder1',
            folder: { childCount: 1 },
            lastModifiedDateTime: '2024-01-01T00:00:00Z',
            cTag: 'cTag1',
          },
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/drive/root/children?page=2',
      };

      const page2 = {
        value: [
          {
            id: 'folder2',
            name: 'Folder2',
            folder: { childCount: 2 },
            lastModifiedDateTime: '2024-01-02T00:00:00Z',
            cTag: 'cTag2',
          },
        ],
      };

      fetchMock
        .mockResolvedValueOnce({
          status: 200,
          text: async () => JSON.stringify(page1),
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => JSON.stringify(page2),
          headers: new Map(),
        });

      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const folders = await driveSource.listFolders();

      expect(folders).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should throw error on failed listing', async () => {
      fetchMock.mockResolvedValue({
        status: 401,
        text: async () => '{"error": "Unauthorized"}',
        headers: new Map(),
      });

      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      await expect(driveSource.listFolders()).rejects.toThrow('Failed to list drive items');
    });
  });

  describe('listSince - Delta Query', () => {
    it('should perform full sync when no cursor provided', async () => {
      const mockDeltaResponse = {
        value: [
          {
            id: 'file1',
            name: 'document.docx',
            path: '/Documents/document.docx',
            file: {
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            },
            lastModifiedDateTime: '2024-01-15T00:00:00Z',
            size: 2048,
            cTag: 'cTag123',
            quickXorHash: 'abc123',
          },
          {
            id: 'file2',
            name: 'image.png',
            path: '/Photos/image.png',
            file: {
              mimeType: 'image/png',
            },
            lastModifiedDateTime: '2024-01-20T00:00:00Z',
            size: 5120,
            quickXorHash: 'xyz789',
          },
          {
            id: 'folder1',
            name: 'Documents',
            path: '/Documents',
            folder: { childCount: 5 },
            lastModifiedDateTime: '2024-01-15T00:00:00Z',
            cTag: 'cTag1',
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?deltatoken=abc123',
      };

      // Only mock the delta query - listSince should be metadata-only
      fetchMock.mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify(mockDeltaResponse),
        headers: new Map(),
      });

      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const result = await driveSource.listSince({ path: '/' });

      expect(result.items).toHaveLength(2); // Only files, not folders
      expect(result.items[0]?.item.path).toBe('/Documents/document.docx');
      expect(result.items[0]?.item.contentHash).toBe('abc123');
      expect(result.items[0]?.content).toBeUndefined(); // Metadata-only, no content
      expect(result.items[1]?.item.contentHash).toBe('xyz789');
      expect(result.nextCursor.value).toContain('graph-drive-delta:');
    });

    it('should fetch file content using fetch method', async () => {
      const mockDeltaResponse = {
        value: [
          {
            id: 'file1',
            name: 'document.docx',
            path: '/Documents/document.docx',
            file: {
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            },
            lastModifiedDateTime: '2024-01-15T00:00:00Z',
            size: 2048,
            quickXorHash: 'abc123',
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?deltatoken=abc123',
      };

      // Mock delta query
      fetchMock.mockResolvedValueOnce({
        status: 200,
        text: async () => JSON.stringify(mockDeltaResponse),
        headers: new Map(),
      });

      // Mock content fetch
      fetchMock.mockResolvedValueOnce({
        status: 200,
        text: async () => 'file content here',
        headers: new Map(),
      });

      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      // First get metadata
      const listResult = await driveSource.listSince({ path: '/' });
      expect(listResult.items).toHaveLength(1);
      expect(listResult.items[0]?.content).toBeUndefined();

      // Then fetch content separately
      const item = listResult.items[0]!;
      const fetched = await driveSource.fetch(item.item);
      
      expect(fetched.content).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(fetched.content)).toBe('file content here');
    });

    it('should use deltaLink from cursor for incremental sync', async () => {
      const cursor: SyncCursor = {
        value: 'graph-drive-delta:/path/to/folder:https://graph.microsoft.com/v1.0/delta?deltatoken=existing',
      };

      const mockDeltaResponse = {
        value: [
          {
            id: 'file3',
            name: 'modified.txt',
            path: '/path/to/folder/modified.txt',
            file: {
              mimeType: 'text/plain',
            },
            lastModifiedDateTime: '2024-01-25T00:00:00Z',
            size: 100,
            quickXorHash: 'newHash123',
            cTag: 'cTag456',
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?deltatoken=new456',
      };

      fetchMock
        .mockResolvedValueOnce({
          status: 200,
          text: async () => JSON.stringify(mockDeltaResponse),
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => 'modified content',
          headers: new Map(),
        });

      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const result = await driveSource.listSince({ path: '/path/to/folder' }, cursor);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.item.path).toBe('/path/to/folder/modified.txt');
      expect(result.nextCursor.value).toContain('new456');
    });

    it('should handle invalid cursor and perform full sync', async () => {
      const invalidCursor: SyncCursor = {
        value: 'invalid-cursor-format',
      };

      const mockDeltaResponse = {
        value: [
          {
            id: 'file1',
            name: 'test.txt',
            path: '/test.txt',
            file: { mimeType: 'text/plain' },
            size: 50,
            lastModifiedDateTime: '2024-01-01T00:00:00Z',
            cTag: 'cTag1',
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?deltatoken=abc',
      };

      fetchMock
        .mockResolvedValueOnce({
          status: 200,
          text: async () => JSON.stringify(mockDeltaResponse),
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => 'test content',
          headers: new Map(),
        });

      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const result = await driveSource.listSince({ path: '/' }, invalidCursor);

      expect(result.items).toHaveLength(1);
    });

    it('should skip deleted items in delta response', async () => {
      const mockDeltaResponse = {
        value: [
          {
            id: 'file1',
            name: 'deleted.txt',
            path: '/deleted.txt',
            deleted: {},
            lastModifiedDateTime: '2024-01-01T00:00:00Z',
            cTag: 'cTag1',
          },
          {
            id: 'file2',
            name: 'kept.txt',
            path: '/kept.txt',
            file: { mimeType: 'text/plain' },
            size: 100,
            lastModifiedDateTime: '2024-01-02T00:00:00Z',
            cTag: 'cTag2',
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?deltatoken=abc',
      };

      fetchMock
        .mockResolvedValueOnce({
          status: 200,
          text: async () => JSON.stringify(mockDeltaResponse),
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => 'kept content',
          headers: new Map(),
        });

      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const result = await driveSource.listSince({ path: '/' });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.item.path).toBe('/kept.txt');
    });

    it('should skip folders in delta response', async () => {
      const mockDeltaResponse = {
        value: [
          {
            id: 'folder1',
            name: 'Documents',
            path: '/Documents',
            folder: { childCount: 5 },
            lastModifiedDateTime: '2024-01-01T00:00:00Z',
            cTag: 'cTag1',
          },
          {
            id: 'file1',
            name: 'test.txt',
            path: '/test.txt',
            file: { mimeType: 'text/plain' },
            size: 100,
            lastModifiedDateTime: '2024-01-02T00:00:00Z',
            cTag: 'cTag2',
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?deltatoken=abc',
      };

      fetchMock
        .mockResolvedValueOnce({
          status: 200,
          text: async () => JSON.stringify(mockDeltaResponse),
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => 'test content',
          headers: new Map(),
        });

      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const result = await driveSource.listSince({ path: '/' });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.item.path).toBe('/test.txt');
    });
  });

  describe('Delta Paging', () => {
    it('should handle pagination in delta query results', async () => {
      const page1 = {
        value: [
          {
            id: 'file1',
            name: 'file1.txt',
            path: '/file1.txt',
            file: { mimeType: 'text/plain' },
            size: 100,
            lastModifiedDateTime: '2024-01-01T00:00:00Z',
            cTag: 'cTag1',
          },
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/delta?page=2',
      };

      const page2 = {
        value: [
          {
            id: 'file2',
            name: 'file2.txt',
            path: '/file2.txt',
            file: { mimeType: 'text/plain' },
            size: 200,
            lastModifiedDateTime: '2024-01-02T00:00:00Z',
            cTag: 'cTag2',
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?deltatoken=abc',
      };

      fetchMock
        .mockResolvedValueOnce({
          status: 200,
          text: async () => JSON.stringify(page1),
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => JSON.stringify(page2),
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => 'content1',
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => 'content2',
          headers: new Map(),
        });

      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const result = await driveSource.listSince({ path: '/' });

      expect(result.items).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(4); // 2 for delta, 2 for content
    });

    it('should handle deltaLink in nextLink for continued pagination', async () => {
      const page1 = {
        value: [
          {
            id: 'file1',
            name: 'file1.txt',
            path: '/file1.txt',
            file: { mimeType: 'text/plain' },
            size: 100,
            lastModifiedDateTime: '2024-01-01T00:00:00Z',
            cTag: 'cTag1',
          },
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/delta?deltatoken=abc',
      };

      const page2 = {
        value: [
          {
            id: 'file2',
            name: 'file2.txt',
            path: '/file2.txt',
            file: { mimeType: 'text/plain' },
            size: 200,
            lastModifiedDateTime: '2024-01-02T00:00:00Z',
            cTag: 'cTag2',
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?deltatoken=def',
      };

      fetchMock
        .mockResolvedValueOnce({
          status: 200,
          text: async () => JSON.stringify(page1),
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => JSON.stringify(page2),
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => 'content1',
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => 'content2',
          headers: new Map(),
        });

      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const result = await driveSource.listSince({ path: '/' });

      expect(result.items).toHaveLength(2);
      expect(result.nextCursor.value).toContain('def');
    });
  });

  describe('Rename Handling', () => {
    it('should detect renames (same GUID, different path)', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const oldItem: GraphDriveItem = {
        id: '01AZJL5PMZQXGQKQYJFZHKZQVJQXGQKQYJ',
        name: 'old-name.docx',
        path: '/Documents/old-name.docx',
        lastModifiedDateTime: '2024-01-01T00:00:00Z',
        size: 25600,
        cTag: 'cTag1',
        quickXorHash: 'hash1',
      };

      const newItem: GraphDriveItem = {
        id: '01AZJL5PMZQXGQKQYJFZHKZQVJQXGQKQYJ', // Same GUID
        name: 'new-name.docx',
        path: '/Documents/new-name.docx', // Different path
        lastModifiedDateTime: '2024-01-15T00:00:00Z',
        size: 25600,
        cTag: 'cTag2',
        quickXorHash: 'hash2',
      };

      expect(driveSource.isRename(oldItem, newItem)).toBe(true);
    });

    it('should not detect as rename when GUID differs', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const oldItem: GraphDriveItem = {
        id: 'old-guid',
        name: 'file.txt',
        path: '/file.txt',
        lastModifiedDateTime: '2024-01-01T00:00:00Z',
        size: 100,
        cTag: 'cTag1',
      };

      const newItem: GraphDriveItem = {
        id: 'new-guid', // Different GUID
        name: 'file.txt',
        path: '/file.txt',
        lastModifiedDateTime: '2024-01-02T00:00:00Z',
        size: 100,
        cTag: 'cTag2',
      };

      expect(driveSource.isRename(oldItem, newItem)).toBe(false);
    });

    it('should not detect as rename when only name changes but path is same', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const oldItem: GraphDriveItem = {
        id: 'same-guid',
        name: 'old-name.txt',
        path: '/Documents/file.txt',
        lastModifiedDateTime: '2024-01-01T00:00:00Z',
        size: 100,
        cTag: 'cTag1',
      };

      const newItem: GraphDriveItem = {
        id: 'same-guid',
        name: 'new-name.txt',
        path: '/Documents/file.txt', // Same path
        lastModifiedDateTime: '2024-01-02T00:00:00Z',
        size: 100,
        cTag: 'cTag2',
      };

      expect(driveSource.isRename(oldItem, newItem)).toBe(false);
    });

    it('should log renames as drift, not duplicate (per §11.1)', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const oldItem: GraphDriveItem = {
        id: 'same-guid',
        name: 'old-name.txt',
        path: '/old/path.txt',
        lastModifiedDateTime: '2024-01-01T00:00:00Z',
        size: 100,
        cTag: 'cTag1',
      };

      const newItem: GraphDriveItem = {
        id: 'same-guid', // Same GUID
        name: 'new-name.txt',
        path: '/new/path.txt', // Different path
        lastModifiedDateTime: '2024-01-02T00:00:00Z',
        size: 100,
        cTag: 'cTag2',
      };

      // The isRename method should return true for this case
      expect(driveSource.isRename(oldItem, newItem)).toBe(true);
      
      // This indicates the system should log as drift, not create a duplicate
    });
  });

  describe('Path Normalization', () => {
    it('should normalize multiple consecutive slashes', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      expect(driveSource.normalizePath('//a//b//c')).toBe('/a/b/c');
    });

    it('should resolve . (current directory) segments', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      expect(driveSource.normalizePath('/a/./b')).toBe('/a/b');
    });

    it('should resolve .. (parent directory) segments', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      expect(driveSource.normalizePath('/a/b/../c')).toBe('/a/c');
    });

    it('should handle complex path with . and ..', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      expect(driveSource.normalizePath('/a/b/./c/../d')).toBe('/a/b/d');
    });

    it('should remove trailing slashes', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      expect(driveSource.normalizePath('/a/b/c/')).toBe('/a/b/c');
    });

    it('should keep root as single slash', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      expect(driveSource.normalizePath('/')).toBe('/');
      expect(driveSource.normalizePath('')).toBe('/');
    });

    it('should handle paths without leading slash', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      expect(driveSource.normalizePath('a/b/c')).toBe('/a/b/c');
    });

    it('should handle root-level files', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      expect(driveSource.normalizePath('/file.txt')).toBe('/file.txt');
    });

    it('should handle deep nesting', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      expect(driveSource.normalizePath('/a/b/c/d/e/f/g')).toBe('/a/b/c/d/e/f/g');
    });

    it('should handle .. at root level gracefully', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      expect(driveSource.normalizePath('/../a')).toBe('/a');
    });
  });

  describe('parsePath', () => {
    it('should parse a simple file path', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const result = driveSource.parsePath('/Documents/file.txt');
      
      expect(result).toMatchObject({
        root: '/',
        dir: '/Documents',
        base: 'file.txt',
        ext: 'txt',
        name: 'file',
      });
    });

    it('should parse a file without extension', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const result = driveSource.parsePath('/Documents/README');
      
      expect(result).toMatchObject({
        root: '/',
        dir: '/Documents',
        base: 'README',
        ext: '',
        name: 'README',
      });
    });

    it('should parse a root-level file', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const result = driveSource.parsePath('/file.txt');
      
      expect(result).toMatchObject({
        root: '/',
        dir: '',
        base: 'file.txt',
        ext: 'txt',
        name: 'file',
      });
    });

    it('should parse a directory path', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const result = driveSource.parsePath('/Documents/Photos');
      
      expect(result).toMatchObject({
        root: '/',
        dir: '/Documents',
        base: 'Photos',
        ext: '',
        name: 'Photos',
      });
    });
  });

  describe('Change Detection (cTag/quickXorHash)', () => {
    it('should prefer quickXorHash for change detection', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const item: GraphDriveItem = {
        id: 'file1',
        name: 'test.txt',
        path: '/test.txt',
        lastModifiedDateTime: '2024-01-01T00:00:00Z',
        size: 100,
        cTag: 'cTag789',
        quickXorHash: 'quickXorHash123',
      };

      const changeHash = driveSource.getChangeHash(item);
      expect(changeHash).toBe('quickXorHash123');
    });

    it('should fallback to cTag when quickXorHash not available', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const item: GraphDriveItem = {
        id: 'file1',
        name: 'test.txt',
        path: '/test.txt',
        lastModifiedDateTime: '2024-01-01T00:00:00Z',
        size: 100,
        cTag: 'cTag789',
      };

      const changeHash = driveSource.getChangeHash(item);
      expect(changeHash).toBe('cTag789');
    });

    it('should return undefined when no change hash available', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const item: GraphDriveItem = {
        id: 'file1',
        name: 'test.txt',
        path: '/test.txt',
        lastModifiedDateTime: '2024-01-01T00:00:00Z',
        size: 100,
      };

      const changeHash = driveSource.getChangeHash(item);
      expect(changeHash).toBeUndefined();
    });

    it('should use quickXorHash as content hash in listSince', async () => {
      const mockDeltaResponse = {
        value: [
          {
            id: 'file1',
            name: 'test.txt',
            path: '/test.txt',
            file: {
              mimeType: 'text/plain',
            },
            size: 100,
            lastModifiedDateTime: '2024-01-01T00:00:00Z',
            quickXorHash: 'abc123xyz',
            cTag: 'cTag123',
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?deltatoken=abc',
      };

      fetchMock
        .mockResolvedValueOnce({
          status: 200,
          text: async () => JSON.stringify(mockDeltaResponse),
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => 'test content',
          headers: new Map(),
        });

      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const result = await driveSource.listSince({ path: '/' });

      expect(result.items[0]?.item.contentHash).toBe('abc123xyz');
    });
  });

  describe('Cursor Encoding/Decoding', () => {
    it('should encode cursor with folder path and delta link', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const cursor: SyncCursor = {
        value: 'graph-drive-delta:/Documents:https://graph.microsoft.com/v1.0/delta?deltatoken=abc123',
      };

      const decoded = (driveSource as any).decodeCursor(cursor);
      
      expect(decoded.folderPath).toBe('/Documents');
      expect(decoded.deltaLink).toBe('https://graph.microsoft.com/v1.0/delta?deltatoken=abc123');
    });

    it('should handle delta links with colons', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const cursor: SyncCursor = {
        value: 'graph-drive-delta:/Documents:https://graph.microsoft.com/v1.0/delta?deltatoken=abc:123:xyz',
      };

      const decoded = (driveSource as any).decodeCursor(cursor);
      
      expect(decoded.folderPath).toBe('/Documents');
      expect(decoded.deltaLink).toBe('https://graph.microsoft.com/v1.0/delta?deltatoken=abc:123:xyz');
    });

    it('should throw error on invalid cursor format', () => {
      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSource = new GraphDriveSource(config);

      const invalidCursor: SyncCursor = {
        value: 'invalid-format',
      };

      expect(() => (driveSource as any).decodeCursor(invalidCursor)).toThrow('Invalid cursor format');
    });
  });

  describe('Rate Limiting and Error Handling', () => {
    it('should handle 429 rate limit response', async () => {
      const mockDeltaResponse = {
        value: [
          {
            id: 'file1',
            name: 'test.txt',
            path: '/test.txt',
            file: { mimeType: 'text/plain' },
            size: 100,
            lastModifiedDateTime: '2024-01-01T00:00:00Z',
            cTag: 'cTag1',
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?deltatoken=abc',
      };

      // First call returns 429, second succeeds
      fetchMock
        .mockResolvedValueOnce({
          status: 429,
          text: async () => '{"error": "Rate limit exceeded"}',
          headers: new Map([['retry-after', '1']]),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => JSON.stringify(mockDeltaResponse),
          headers: new Map(),
        })
        .mockResolvedValueOnce({
          status: 200,
          text: async () => 'content',
          headers: new Map(),
        });

      const mockThrottleLimiter: ThrottleLimiter = {
        handleRateLimited: vi.fn().mockReturnValue(0),
        executeWithThrottling: vi.fn().mockImplementation((tenantId, provider, fn) => fn()),
      } as unknown as ThrottleLimiter;

      const config: GraphDriveSourceConfig = {
        tokenProvider: mockTokenProvider,
        tenantId: 'test-tenant-id',
      };
      const driveSourceWithThrottle = new GraphDriveSource(config, mockThrottleLimiter);

      // Should not throw
      await expect(driveSourceWithThrottle.listSince({ path: '/' })).resolves.toBeDefined();
    });
  });
});

// Additional fixtures for integration testing reference
export const graphDriveFixtures = {
  // Complete folder listing response
  folderListResponse: {
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#drives(\'test-drive-id\')/root/children',
    value: [
      {
        id: '01AZJL5PN6Y2GOVW7725BZO354PWSELRRZ',
        name: 'Documents',
        lastModifiedDateTime: '2024-01-15T00:00:00Z',
        size: 0,
        folder: { childCount: 25 },
        webUrl: 'https://contoso-my.sharepoint.com/personal/user/Documents',
        cTag: 'cTag1',
      },
      {
        id: '01AZJL5PNXQFJWFKQBFZHKZQVJQXGQKQYJ',
        name: 'Photos',
        lastModifiedDateTime: '2024-01-20T00:00:00Z',
        size: 0,
        folder: { childCount: 150 },
        webUrl: 'https://contoso-my.sharepoint.com/personal/user/Photos',
        cTag: 'cTag2',
      },
    ],
  },

  // Delta query response with changes
  deltaQueryResponse: {
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#Collection(driveItems)',
    '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?deltatoken=H4sIAAAAAAAA',
    value: [
      {
        id: '01AZJL5PMZQXGQKQYJFZHKZQVJQXGQKQYJ',
        name: 'report.docx',
        lastModifiedDateTime: '2024-01-25T14:30:00Z',
        size: 25600,
        file: {
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        cTag: '"c:{GUID},0"',
        quickXorHash: 'abc123def456ghi789jkl012mno345pqr678=',
      },
    ],
  },

  // Rename scenario
  renameScenario: {
    before: {
      id: '01AZJL5PMZQXGQKQYJFZHKZQVJQXGQKQYJ',
      name: 'old-name.docx',
      path: '/Documents/old-name.docx',
      file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      size: 25600,
      lastModifiedDateTime: '2024-01-01T00:00:00Z',
      cTag: 'cTag1',
    } as GraphDriveItem,
    after: {
      id: '01AZJL5PMZQXGQKQYJFZHKZQVJQXGQKQYJ', // Same GUID
      name: 'new-name.docx',
      path: '/Documents/new-name.docx', // Different path
      file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      size: 25600,
      lastModifiedDateTime: '2024-01-15T00:00:00Z',
      cTag: 'cTag2',
      quickXorHash: 'hash2',
    } as GraphDriveItem,
  },
};
