import type { MailKeyword } from './mail';

/**
 * Map IMAP system flags (RFC 3501) to the JMAP keywords we model, and back.
 * Our `MailKeyword` values ARE the JMAP keyword names ($seen/$flagged/$draft/$answered).
 */
const IMAP_FLAG_TO_KEYWORD: Readonly<Record<string, MailKeyword>> = {
  '\\Seen': '$seen',
  '\\Flagged': '$flagged',
  '\\Draft': '$draft',
  '\\Answered': '$answered',
};

const KEYWORD_TO_IMAP_FLAG: Readonly<Record<MailKeyword, string>> = {
  $seen: '\\Seen',
  $flagged: '\\Flagged',
  $draft: '\\Draft',
  $answered: '\\Answered',
};

/** IMAP system flag (e.g. "\\Seen") -> JMAP keyword, or undefined if we don't model it. */
export function imapFlagToKeyword(flag: string): MailKeyword | undefined {
  return IMAP_FLAG_TO_KEYWORD[flag];
}

/** JMAP keyword -> IMAP system flag (e.g. "$seen" -> "\\Seen"). */
export function keywordToImapFlag(keyword: MailKeyword): string {
  return KEYWORD_TO_IMAP_FLAG[keyword];
}

/** Map a set of IMAP flags to modeled keywords (unmodeled flags dropped, de-duplicated, stable order). */
export function imapFlagsToKeywords(flags: Iterable<string>): MailKeyword[] {
  const out = new Set<MailKeyword>();
  for (const f of flags) {
    const k = imapFlagToKeyword(f);
    if (k) out.add(k);
  }
  return [...out];
}
