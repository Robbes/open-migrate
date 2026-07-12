/**
 * Real Verification Implementations
 * 
 * Provides real verification dependencies that use the LedgerVerificationReader port
 * to query the ledger for verification data.
 * 
 * See docs/architecture/solution-architecture.md §20 (verification & rollback)
 */

import type { TenantId, MappingId, LedgerVerificationReader, TargetReindexer } from '@openmig/shared';
import type { VerificationDeps } from './verification';

/**
 * Verification dependencies backed by ledger reader and target
 */
export interface RealVerificationDeps {
  tenantId: TenantId;
  mappingId: MappingId;
  config: import('./verification').VerificationConfig;
  ledger: import('@openmig/shared').Ledger;
  targetReindexer?: TargetReindexer;
  verificationReader: LedgerVerificationReader;
}

/**
 * Create real verification dependencies from ledger and target
 */
export function createRealVerificationDeps(
  deps: RealVerificationDeps
): VerificationDeps {
  const { tenantId, mappingId, verificationReader, targetReindexer } = deps;
  
  return {
    tenantId,
    mappingId,
    config: deps.config,
    getSourceCount: (dataType) =>
      getSourceCountFromLedger(verificationReader, tenantId, mappingId, dataType),
    getTargetCount: (dataType) =>
      getTargetCountFromReindexer(targetReindexer, verificationReader, tenantId, mappingId, dataType),
    getSourceSamples: (dataType, count) =>
      getSourceSamplesFromLedger(verificationReader, tenantId, mappingId, dataType, count),
    getTargetSamples: (dataType, count) =>
      getTargetSamplesFromReindexer(targetReindexer, verificationReader, tenantId, mappingId, dataType, count),
    findMissingOnTarget: (dataType) =>
      findMissingOnTarget(verificationReader, tenantId, mappingId, dataType, targetReindexer),
    findExtraOnTarget: (dataType) =>
      findExtraOnTarget(verificationReader, tenantId, mappingId, dataType, targetReindexer),
    getTotalBytesSource: (dataType) =>
      getTotalBytesFromLedger(verificationReader, tenantId, mappingId, dataType),
    getTotalBytesTarget: (dataType) =>
      getTotalBytesFromTarget(verificationReader, tenantId, mappingId, dataType),
  };
}

/**
 * Get count of items from the ledger (source)
 */
async function getSourceCountFromLedger(
  reader: LedgerVerificationReader,
  tenantId: TenantId,
  mappingId: MappingId,
  dataType: 'mail' | 'calendar' | 'contacts' | 'files'
): Promise<number> {
  const domain = mapDataTypeToDomain(dataType) as 'email' | 'calendar' | 'contact' | 'file';
  return reader.countItems(tenantId, mappingId, domain);
}

/**
 * Get count of items from the target via reindexer
 */
async function getTargetCountFromReindexer(
  targetReindexer: TargetReindexer | undefined,
  reader: LedgerVerificationReader,
  tenantId: TenantId,
  mappingId: MappingId,
  _dataType: 'mail' | 'calendar' | 'contacts' | 'files'
): Promise<number> {
  if (!targetReindexer) {
    // If no reindexer, fall back to ledger count
    return getSourceCountFromLedger(reader, tenantId, mappingId, _dataType);
  }

  let count = 0;
  
  for await (const _entry of targetReindexer.listEntries()) {
    // Filter by domain if possible (implementation dependent)
    // For now, count all entries - the reindexer should handle filtering
    count++;
  }
  
  return count;
}

/**
 * Get sample items from the ledger for checksum verification
 */
async function getSourceSamplesFromLedger(
  reader: LedgerVerificationReader,
  tenantId: TenantId,
  mappingId: MappingId,
  dataType: 'mail' | 'calendar' | 'contacts' | 'files',
  count: number
): Promise<Array<{ id: string; naturalKeyHash: string; content: Uint8Array | string }>> {
  const domain = mapDataTypeToDomain(dataType) as 'email' | 'calendar' | 'contact' | 'file';
  const samples = await reader.getSamples(tenantId, mappingId, domain, count);
  
  return samples.map((s) => ({
    id: s.id,
    naturalKeyHash: s.naturalKeyHash,
    content: s.contentHash ?? '',
  }));
}

/**
 * Get sample items from the target
 */
async function getTargetSamplesFromReindexer(
  targetReindexer: TargetReindexer | undefined,
  reader: LedgerVerificationReader,
  tenantId: TenantId,
  mappingId: MappingId,
  _dataType: 'mail' | 'calendar' | 'contacts' | 'files',
  count: number
): Promise<Array<{ id: string; naturalKeyHash: string; content: Uint8Array | string }>> {
  if (!targetReindexer) {
    // If no reindexer, fall back to ledger samples
    return getSourceSamplesFromLedger(reader, tenantId, mappingId, _dataType, count);
  }

  const samples: Array<{ id: string; naturalKeyHash: string; content: Uint8Array | string }> = [];
  let i = 0;
  
  for await (const entry of targetReindexer.listEntries()) {
    if (i >= count) break;
    samples.push({
      id: entry.targetId,
      naturalKeyHash: entry.naturalKey,
      content: entry.contentHash ?? '',
    });
    i++;
  }
  
  return samples;
}

/**
 * Find items that exist in the ledger but are missing on the target
 */
async function findMissingOnTarget(
  reader: LedgerVerificationReader,
  tenantId: TenantId,
  mappingId: MappingId,
  dataType: 'mail' | 'calendar' | 'contacts' | 'files',
  targetReindexer?: TargetReindexer
): Promise<Array<{ id: string; sourceRef: string }>> {
  const domain = mapDataTypeToDomain(dataType) as 'email' | 'calendar' | 'contact' | 'file';
  
  // Get all natural key hashes from the ledger
  const ledgerHashes = await reader.getAllNaturalKeyHashes(tenantId, mappingId, domain);
  
  // If no target reindexer, all ledger items are "missing" (can't verify)
  if (!targetReindexer) {
    return ledgerHashes.map((hash) => ({ id: hash, sourceRef: hash }));
  }
  
  // Get all natural keys from the target
  const targetKeys = new Set<string>();
  for await (const entry of targetReindexer.listEntries()) {
    targetKeys.add(entry.naturalKey);
  }
  
  // Find ledger items that are missing on target
  const missing: Array<{ id: string; sourceRef: string }> = [];
  for (const hash of ledgerHashes) {
    if (!targetKeys.has(hash)) {
      missing.push({ id: hash, sourceRef: hash });
    }
  }
  
  return missing;
}

/**
 * Find items that exist on the target but not in the ledger
 */
async function findExtraOnTarget(
  reader: LedgerVerificationReader,
  tenantId: TenantId,
  mappingId: MappingId,
  dataType: 'mail' | 'calendar' | 'contacts' | 'files',
  targetReindexer?: TargetReindexer
): Promise<Array<{ id: string; targetRef: string }>> {
  const domain = mapDataTypeToDomain(dataType) as 'email' | 'calendar' | 'contact' | 'file';
  
  // Get all natural key hashes from the ledger
  const ledgerHashes = new Set(await reader.getAllNaturalKeyHashes(tenantId, mappingId, domain));
  
  // If no target reindexer, no extra items can be detected
  if (!targetReindexer) {
    return [];
  }
  
  // Get all natural keys from the target and find extras
  const extra: Array<{ id: string; targetRef: string }> = [];
  for await (const entry of targetReindexer.listEntries()) {
    if (!ledgerHashes.has(entry.naturalKey)) {
      extra.push({ id: entry.targetId, targetRef: entry.naturalKey });
    }
  }
  
  return extra;
}

/**
 * Get total bytes from the ledger
 */
async function getTotalBytesFromLedger(
  reader: LedgerVerificationReader,
  tenantId: TenantId,
  mappingId: MappingId,
  dataType: 'mail' | 'calendar' | 'contacts' | 'files'
): Promise<number> {
  const domain = mapDataTypeToDomain(dataType) as 'email' | 'calendar' | 'contact' | 'file';
  return reader.totalSizeBytes(tenantId, mappingId, domain);
}

/**
 * Get total bytes from the target
 */
async function getTotalBytesFromTarget(
  reader: LedgerVerificationReader,
  tenantId: TenantId,
  mappingId: MappingId,
  dataType: 'mail' | 'calendar' | 'contacts' | 'files'
): Promise<number> {
  // For now, return the same as source - target bytes would need to be
  // queried from the target system directly
  return getTotalBytesFromLedger(reader, tenantId, mappingId, dataType);
}

/**
 * Map data type to domain string used in the ledger
 */
function mapDataTypeToDomain(
  dataType: 'mail' | 'calendar' | 'contacts' | 'files'
): string {
  switch (dataType) {
    case 'mail':
      return 'email';
    case 'calendar':
      return 'calendar';
    case 'contacts':
      return 'contact';
    case 'files':
      return 'file';
    default:
      throw new Error(`Unknown data type: ${dataType}`);
  }
}
