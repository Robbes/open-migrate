// Copyright 2026 OpenHands Agent (Apache-2.0)
// Integration tests for WebDAV source connector against a real Nextcloud WebDAV server.
// Uses Testcontainers for containerized Nextcloud instance.
//
// TEST SCENARIOS:
// - listFolders() discovers seeded folders
// - listSince() returns changed files
// - Cursor round-trip (second call returns only changes)
// - Idempotency: run twice, second run creates 0 items

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { WebdavFileSource } from './webdav-source';
import type { WebDAVSourceConfig } from './webdav-source.types';
import type { RawFileItem as _RawFileItem } from '@openmig/shared';

// Nextcloud WebDAV configuration from Testcontainers
const NEXTCLOUD_WEBDAV_URL = process.env.NEXTCLOUD_WEBDAV_URL;
const NEXTCLOUD_USERNAME = process.env.NEXTCLOUD_USERNAME || 'testadmin';
const NEXTCLOUD_PASSWORD = process.env.NEXTCLOUD_PASSWORD || 'testadmin_password';

if (!NEXTCLOUD_WEBDAV_URL) {
  throw new Error(
    'Nextcloud WebDAV is required for WebDAV source tests. ' +
    'Set NEXTCLOUD_WEBDAV_URL environment variable. ' +
    'Run: pnpm test:integration'
  );
}

// Test folder and file names
const TEST_FOLDER_NAME = 'Test Folder';
const TEST_FOLDER_PATH = `/files/${NEXTCLOUD_USERNAME}/${TEST_FOLDER_NAME}`;
const TEST_FILE_1 = 'test-file-1.txt';
const TEST_FILE_2 = 'test-file-2.md';
const TEST_FILE_3 = 'test-file-3.json';

/**
 * Wait for Nextcloud WebDAV server to be ready.
 */
async function waitForWebdav(maxRetries = 60, delayMs = 3000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(NEXTCLOUD_WEBDAV_URL!, {
        method: 'PROPFIND',
        headers: {
          Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
        },
      });
      if (response.status === 207 || response.status === 401) {
        return;
      }
    } catch {
      // WebDAV not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error('WebDAV server not ready after max retries');
}

/**
 * Seed test files via raw WebDAV PUT.
 * Creates a test folder and populates it with test files.
 */
async function seedFiles(): Promise<void> {
  const webdavUrl = NEXTCLOUD_WEBDAV_URL!.replace(/\/$/, '');
  const testFolderUrl = `${webdavUrl}${TEST_FOLDER_PATH}`;

  // First, create the test folder using MKCOL
  try {
    const response = await fetch(testFolderUrl, {
      method: 'MKCOL',
      headers: {
        Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
      },
    });

    if (response.status === 201 || response.status === 409) {
      console.log('[Seed] Created test folder');
    } else {
      console.log(`[Seed] Folder creation response: ${response.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Seed] Folder creation (may already exist): ${msg}`);
  }

  // Seed test files
  const testFiles = [
    {
      name: TEST_FILE_1,
      content: 'This is the first test file for WebDAV integration tests.\nIt contains plain text content.',
      mimeType: 'text/plain',
    },
    {
      name: TEST_FILE_2,
      content: '# Test Markdown File\n\nThis is a markdown file for testing.\n\n- Item 1\n- Item 2\n- Item 3',
      mimeType: 'text/markdown',
    },
    {
      name: TEST_FILE_3,
      content: JSON.stringify({
        name: 'Test Data',
        version: '1.0.0',
        items: ['item1', 'item2', 'item3'],
        metadata: {
          created: '2024-01-01T00:00:00Z',
          author: 'test@dev.local',
        },
      }, null, 2),
      mimeType: 'application/json',
    },
  ];

  for (const file of testFiles) {
    const fileUrl = `${testFolderUrl}/${file.name}`;
    
    try {
      const response = await fetch(fileUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.mimeType,
          Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
        },
        body: file.content,
      });

      if (response.status === 201 || response.status === 204) {
        console.log(`[Seed] Created file: ${file.name}`);
      } else {
        console.warn(`[Seed] File ${file.name} response: ${response.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Seed] Warning: Could not seed file ${file.name}: ${msg}`);
    }
  }

  console.log('[Seed] Test files seeded');
}

/**
 * Clean up test folder and files.
 */
async function cleanTestFolder(): Promise<void> {
  const webdavUrl = NEXTCLOUD_WEBDAV_URL!.replace(/\/$/, '');
  const testFolderUrl = `${webdavUrl}${TEST_FOLDER_PATH}`;

  try {
    // First, list all files in the folder using PROPFIND
    const response = await fetch(`${webdavUrl}${TEST_FOLDER_PATH}/`, {
      method: 'PROPFIND',
      headers: {
        'Depth': '1',
        'Content-Type': 'application/xml',
        Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
        <D:propfind xmlns:D="DAV:">
          <D:prop>
            <D:resourcetype/>
          </D:prop>
        </D:propfind>`,
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
        // Only delete resources in our test folder
        if (href.includes(TEST_FOLDER_NAME)) {
          resourcesToDelete.push(href);
        }
      }

      // Delete files first (deepest first)
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

    // Delete the folder itself
    try {
      await fetch(testFolderUrl, {
        method: 'DELETE',
        headers: {
          Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
        },
      });
    } catch {
      // Ignore folder deletion errors
    }

    console.log('[Cleanup] Test folder cleaned');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Cleanup] Warning: Could not clean test folder: ${msg}`);
  }
}

describe('WebDAV Source Integration Tests', () => {
  let webdavSource: WebdavFileSource;

  beforeAll(async () => {
    console.log('[WebDAV Tests] Waiting for WebDAV server...');
    await waitForWebdav();
    console.log('[WebDAV Tests] WebDAV server is ready');
  }, 120000);

  beforeEach(async () => {
    // Clean up before each test for isolation
    await cleanTestFolder();
    await seedFiles();
  });

  afterAll(async () => {
    // Final cleanup
    await cleanTestFolder();
  });

  describe('listFolders()', () => {
    it('should discover seeded folders', async () => {
      webdavSource = new WebdavFileSource({
        url: NEXTCLOUD_WEBDAV_URL!,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
        rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
      } as WebDAVSourceConfig);

      // Set password via environment
      process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;

      const folders = await webdavSource.listFolders();

      expect(folders).toBeDefined();
      expect(Array.isArray(folders)).toBe(true);
      
      // Should find at least the test folder
      const testFolder = folders.find(f => f.name === TEST_FOLDER_NAME);
      expect(testFolder).toBeDefined();
      expect(testFolder?.name).toBe(TEST_FOLDER_NAME);

      console.log('[listFolders] Discovered folders:', folders.map(f => f.name));
    });
  });

  describe('listSince()', () => {
    it('should return changed files with correct metadata', async () => {
      webdavSource = new WebdavFileSource({
        url: NEXTCLOUD_WEBDAV_URL!,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
        rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
      } as WebDAVSourceConfig);

      process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;

      // First, get the test folder
      const folders = await webdavSource.listFolders();
      const testFolder = folders.find(f => f.name === TEST_FOLDER_NAME);
      expect(testFolder).toBeDefined();

      // List files since epoch (all files)
      const { items, nextCursor } = await webdavSource.listSince(testFolder!);

      expect(items).toBeDefined();
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBeGreaterThanOrEqual(3);

      // Verify each file has correct structure
      for (const item of items) {
        expect(item.item).toBeDefined();
        expect(item.item.path).toBeDefined();
        expect(item.item.size).toBeDefined();
        expect(item.item.modifiedAt).toBeDefined();
        expect(item.item.etag).toBeDefined();
        expect(item.content).toBeDefined();

        // Verify content is a Uint8Array
        expect(item.content).toBeInstanceOf(Uint8Array);
      }

      // Verify our test files are present
      const filePaths = items.map(i => i.item.path);
      expect(filePaths).toContain(TEST_FILE_1);
      expect(filePaths).toContain(TEST_FILE_2);
      expect(filePaths).toContain(TEST_FILE_3);

      expect(nextCursor).toBeDefined();
      expect(nextCursor.value).toBeDefined();

      console.log('[listSince] Found', items.length, 'files');
    });

    it('should support cursor round-trip (second call returns only changes)', async () => {
      webdavSource = new WebdavFileSource({
        url: NEXTCLOUD_WEBDAV_URL!,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
        rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
      } as WebDAVSourceConfig);

      process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;

      const folders = await webdavSource.listFolders();
      const testFolder = folders.find(f => f.name === TEST_FOLDER_NAME);
      expect(testFolder).toBeDefined();

      // First call - get all files
      const result1 = await webdavSource.listSince(testFolder!);
      const initialCount = result1.items.length;
      expect(initialCount).toBeGreaterThanOrEqual(3);
      expect(result1.nextCursor.value).toBeDefined();

      // Second call with cursor - should return no new items (all already seen)
      const result2 = await webdavSource.listSince(testFolder!, result1.nextCursor);
      
      // With cursor-based sync, unchanged data should return empty results
      expect(result2.items.length).toBe(0);
      
      console.log('[Cursor Round-trip] First call:', initialCount, 'files, Second call:', result2.items.length, 'files');
    });
  });

  describe('Idempotency', () => {
    it('should be idempotent (run twice, second run creates 0 new items)', async () => {
      webdavSource = new WebdavFileSource({
        url: NEXTCLOUD_WEBDAV_URL!,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
        rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
      } as WebDAVSourceConfig);

      process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;

      const folders = await webdavSource.listFolders();
      const testFolder = folders.find(f => f.name === TEST_FOLDER_NAME);
      expect(testFolder).toBeDefined();

      // First sync - collect all files
      const sync1 = await webdavSource.listSince(testFolder!);
      const firstRunCount = sync1.items.length;
      expect(firstRunCount).toBeGreaterThanOrEqual(3);

      // Second sync with cursor - should get no new items
      const sync2 = await webdavSource.listSince(testFolder!, sync1.nextCursor);
      
      // Idempotency: second sync should not return new items
      expect(sync2.items.length).toBe(0);

      console.log('[Idempotency] First sync:', firstRunCount, 'files, Second sync:', sync2.items.length, 'files');
    });
  });

  describe('File content', () => {
    it('should correctly fetch file content', async () => {
      webdavSource = new WebdavFileSource({
        url: NEXTCLOUD_WEBDAV_URL!,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
        rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
      } as WebDAVSourceConfig);

      process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;

      const folders = await webdavSource.listFolders();
      const testFolder = folders.find(f => f.name === TEST_FOLDER_NAME);
      expect(testFolder).toBeDefined();

      const { items } = await webdavSource.listSince(testFolder!);

      // Find our first test file
      const testFile = items.find(i => i.item.path === TEST_FILE_1);
      expect(testFile).toBeDefined();

      // Verify content
      const decoder = new TextDecoder();
      const content = decoder.decode(testFile!.content);
      expect(content).toContain('This is the first test file for WebDAV integration tests');
      expect(content).toContain('plain text content');

      console.log('[File Content] Verified file content');
    });

    it('should handle different file types correctly', async () => {
      webdavSource = new WebdavFileSource({
        url: NEXTCLOUD_WEBDAV_URL!,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
        rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
      } as WebDAVSourceConfig);

      process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;

      const folders = await webdavSource.listFolders();
      const testFolder = folders.find(f => f.name === TEST_FOLDER_NAME);
      expect(testFolder).toBeDefined();

      const { items } = await webdavSource.listSince(testFolder!);

      // Find the JSON file
      const jsonFile = items.find(i => i.item.path === TEST_FILE_3);
      expect(jsonFile).toBeDefined();

      // Verify JSON content can be parsed
      const decoder = new TextDecoder();
      const content = decoder.decode(jsonFile!.content);
      const jsonData = JSON.parse(content);
      
      expect(jsonData.name).toBe('Test Data');
      expect(jsonData.version).toBe('1.0.0');
      expect(jsonData.items).toEqual(['item1', 'item2', 'item3']);
      expect(jsonData.metadata.author).toBe('test@dev.local');

      console.log('[File Content] Verified different file types');
    });
  });

  describe('Delta sync', () => {
    it('should detect file modifications correctly', async () => {
      webdavSource = new WebdavFileSource({
        url: NEXTCLOUD_WEBDAV_URL!,
        username: NEXTCLOUD_USERNAME,
        passwordEnv: 'NEXTCLOUD_PASSWORD',
        rootPath: `/files/${NEXTCLOUD_USERNAME}/`,
      } as WebDAVSourceConfig);

      process.env.NEXTCLOUD_PASSWORD = NEXTCLOUD_PASSWORD;

      const folders = await webdavSource.listFolders();
      const testFolder = folders.find(f => f.name === TEST_FOLDER_NAME);
      expect(testFolder).toBeDefined();

      // First sync
      const sync1 = await webdavSource.listSince(testFolder!);
      expect(sync1.items.length).toBeGreaterThanOrEqual(3);

      // Modify one file by uploading a new version
      const webdavUrl = NEXTCLOUD_WEBDAV_URL!.replace(/\/$/, '');
      const modifiedFileUrl = `${webdavUrl}${TEST_FOLDER_PATH}/${TEST_FILE_1}`;
      
      const modifiedContent = 'This file has been MODIFIED for delta sync testing.\nNew content added.';
      
      await fetch(modifiedFileUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'text/plain',
          Authorization: `Basic ${Buffer.from(`${NEXTCLOUD_USERNAME}:${NEXTCLOUD_PASSWORD}`).toString('base64')}`,
        },
        body: modifiedContent,
      });

      console.log('[Delta Test] Modified file:', TEST_FILE_1);

      // Second sync with cursor - should detect the modified file
      const sync2 = await webdavSource.listSince(testFolder!, sync1.nextCursor);
      
      // Should detect the modified file
      expect(sync2.items.length).toBe(1);
      expect(sync2.items[0]!.item.path).toBe(TEST_FILE_1);

      // Verify the modified content
      const decoder = new TextDecoder();
      const content = decoder.decode(sync2.items[0]!.content);
      expect(content).toContain('MODIFIED');
      expect(content).toContain('delta sync testing');

      console.log('[Delta Test] Detected file modification correctly');
    });
  });
});
