import { describe, it, expect } from 'vitest';
import { naturalKeyHash, normalizeMessageId, contentHash } from './hash';

describe('hash helpers', () => {
  it('natural key ignores angle brackets and surrounding whitespace', () => {
    const a = naturalKeyHash('<abc@example.com>');
    const b = naturalKeyHash('  abc@example.com  ');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different message-ids produce different keys', () => {
    expect(naturalKeyHash('<a@x>')).not.toBe(naturalKeyHash('<b@x>'));
  });

  it('normalizeMessageId strips a single surrounding pair of angle brackets', () => {
    expect(normalizeMessageId('<id@host>')).toBe('id@host');
    expect(normalizeMessageId('id@host')).toBe('id@host');
  });

  it('content hash is stable for identical bytes and differs for changed bytes', () => {
    const enc = new TextEncoder();
    const bytes = enc.encode('From: a\r\n\r\nhello');
    const same = enc.encode('From: a\r\n\r\nhello');
    const diff = enc.encode('From: a\r\n\r\nHELLO');
    expect(contentHash(bytes)).toBe(contentHash(same));
    expect(contentHash(bytes)).not.toBe(contentHash(diff));
    expect(contentHash(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });
});
