import { describe, it, expect } from 'vitest';
import { imapFlagToKeyword, keywordToImapFlag, imapFlagsToKeywords } from './keywords';

describe('keyword mapping', () => {
  it('maps IMAP system flags to JMAP keywords', () => {
    expect(imapFlagToKeyword('\\Seen')).toBe('$seen');
    expect(imapFlagToKeyword('\\Flagged')).toBe('$flagged');
    expect(imapFlagToKeyword('\\Draft')).toBe('$draft');
    expect(imapFlagToKeyword('\\Answered')).toBe('$answered');
    expect(imapFlagToKeyword('\\Deleted')).toBeUndefined();
  });

  it('round-trips keyword -> flag', () => {
    expect(keywordToImapFlag('$seen')).toBe('\\Seen');
    expect(keywordToImapFlag('$answered')).toBe('\\Answered');
  });

  it('maps a flag set, dropping unmodeled flags and de-duplicating', () => {
    expect(imapFlagsToKeywords(['\\Seen', '\\Recent', '\\Seen', '\\Flagged'])).toEqual(['$seen', '$flagged']);
  });
});
