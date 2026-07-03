import type { SyncCursor } from './ports';

/**
 * IMAP incremental cursor = (UIDVALIDITY, UIDNEXT), encoded as "uidValidity:uidNext".
 * Cursors are non-authoritative (ADR-0020): if decoding fails, the caller does a full re-scan,
 * which is still idempotent via the ledger.
 */
export interface ImapCursor {
  readonly uidValidity: number;
  readonly uidNext: number;
}

export function encodeImapCursor(c: ImapCursor): SyncCursor {
  return { value: `${c.uidValidity}:${c.uidNext}` };
}

/** Decode an IMAP cursor; returns undefined if malformed (caller should then re-scan). */
export function decodeImapCursor(cursor: SyncCursor): ImapCursor | undefined {
  const parts = cursor.value.split(':');
  if (parts.length !== 2) return undefined;
  const uidValidity = Number(parts[0]);
  const uidNext = Number(parts[1]);
  if (!Number.isInteger(uidValidity) || !Number.isInteger(uidNext)) return undefined;
  return { uidValidity, uidNext };
}
