import { describe, it, expect } from 'vitest';
import { specialUseFromAttributes, specialUseFromName, detectSpecialUse } from './specialUse';

describe('special-use detection', () => {
  it('reads RFC 6154 attributes', () => {
    expect(specialUseFromAttributes(['\\Sent'])).toBe('sent');
    expect(specialUseFromAttributes(['\\HasNoChildren', '\\Trash'])).toBe('trash');
    expect(specialUseFromAttributes(['\\HasChildren'])).toBe('normal');
  });

  it('falls back to folder-name conventions', () => {
    expect(specialUseFromName('INBOX')).toBe('inbox');
    expect(specialUseFromName('Sent Items')).toBe('sent');
    expect(specialUseFromName('Deleted Items')).toBe('trash');
    expect(specialUseFromName('Spam')).toBe('junk');
    expect(specialUseFromName('Projects')).toBe('normal');
  });

  it('prefers attributes over name', () => {
    expect(detectSpecialUse('Weird Name', ['\\Drafts'])).toBe('drafts');
    expect(detectSpecialUse('Sent', [])).toBe('sent'); // no attribute match -> name
    expect(detectSpecialUse('Projects')).toBe('normal');
  });
});
