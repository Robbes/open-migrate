/**
 * Verification Engine
 * 
 * Verifies migration completeness and accuracy across all data types:
 * - Mail (JMAP/IMAP)
 * - Calendar (CalDAV)
 * - Contacts (CardDAV)
 * - Files (WebDAV)
 * 
 * Provides detailed reports for cutover decision-making.
 */

import type { TenantId, MappingId } from '@openmig/shared';

/** Verification status for a single data type */
export interface DataTypeVerification {
  dataType: 'mail' | 'calendar' | 'contacts' | 'files';
  status: 'PASS' | 'WARN' | 'FAIL';
  
  // Statistics
  sourceCount: number;
  targetCount: number;
  matchedCount: number;
  missingOnTarget: number;
  extraOnTarget: number;
  
  // Content verification
  checksumSampleSize: number;
  checksumMatches: number;
  checksumMismatches: number;
  
  // Bytes transferred
  totalBytesSource: number;
  totalBytesTarget: number;
  
  // Issues
  issues: Array<{
    id: string;
    severity: 'ERROR' | 'WARNING';
    message: string;
    sourceRef?: string;
    targetRef?: string;
  }>;
}

/** Overall verification result */
export interface VerificationResult {
  tenantId: TenantId;
  mappingId: MappingId;
  timestamp: string;
  overallStatus: 'PASS' | 'WARN' | 'FAIL';
  score: number; // 0.0 to 1.0
  
  // Per-data-type results
  mail: DataTypeVerification;
  calendar: DataTypeVerification;
  contacts: DataTypeVerification;
  files: DataTypeVerification;
  
  // Summary
  totalItemsSource: number;
  totalItemsTarget: number;
  totalDiscrepancies: number;
  totalBytesTransferred: number;
  
  // Recommendations
  canProceedToCutover: boolean;
  recommendations: string[];
}

/** Verification configuration */
export interface VerificationConfig {
  // Sampling
  checksumSamplePercentage: number; // Default: 5%
  minSampleSize: number; // Default: 10
  maxSampleSize: number; // Default: 1000
  
  // Thresholds
  requiredMatchPercentage: number; // Default: 0.99 (99%)
  maxDiscrepancyPercentage: number; // Default: 0.01 (1%)
  
  // Data type specific
  verifyMail: boolean; // Default: true
  verifyCalendar: boolean; // Default: true
  verifyContacts: boolean; // Default: true
  verifyFiles: boolean; // Default: true
}

/** Verification dependencies */
export interface VerificationDeps {
  tenantId: TenantId;
  mappingId: MappingId;
  config: VerificationConfig;
  
  // Data access
  getSourceCount(dataType: 'mail' | 'calendar' | 'contacts' | 'files'): Promise<number>;
  getTargetCount(dataType: 'mail' | 'calendar' | 'contacts' | 'files'): Promise<number>;
  
  // Sample retrieval for checksum verification
  getSourceSamples(
    dataType: 'mail' | 'calendar' | 'contacts' | 'files',
    count: number
  ): Promise<Array<{ id: string; naturalKeyHash: string; content: Uint8Array | string }>>;
  
  getTargetSamples(
    dataType: 'mail' | 'calendar' | 'contacts' | 'files',
    count: number
  ): Promise<Array<{ id: string; naturalKeyHash: string; content: Uint8Array | string }>>;
  
  // Discrepancy detection
  findMissingOnTarget(
    dataType: 'mail' | 'calendar' | 'contacts' | 'files'
  ): Promise<Array<{ id: string; sourceRef: string }>>;
  
  findExtraOnTarget(
    dataType: 'mail' | 'calendar' | 'contacts' | 'files'
  ): Promise<Array<{ id: string; targetRef: string }>>;
  
  // Bytes tracking
  getTotalBytesSource(dataType: 'mail' | 'calendar' | 'contacts' | 'files'): Promise<number>;
  getTotalBytesTarget(dataType: 'mail' | 'calendar' | 'contacts' | 'files'): Promise<number>;
}

/**
 * Run verification for all data types
 */
export async function runVerification(
  deps: VerificationDeps
): Promise<VerificationResult> {
  const { tenantId, mappingId, config: _config } = deps;
  
  // Verify each data type
  const mail = await verifyDataType({
    ...deps,
    dataType: 'mail',
  });
  
  const calendar = await verifyDataType({
    ...deps,
    dataType: 'calendar',
  });
  
  const contacts = await verifyDataType({
    ...deps,
    dataType: 'contacts',
  });
  
  const files = await verifyDataType({
    ...deps,
    dataType: 'files',
  });
  
  // Calculate overall status
  const allVerifications = [mail, calendar, contacts, files];
  const overallStatus = calculateOverallStatus(allVerifications);
  const score = calculateVerificationScore(allVerifications);
  
  // Generate recommendations
  const recommendations = generateRecommendations(allVerifications, overallStatus);
  
  // Calculate totals
  const totalItemsSource = allVerifications.reduce((sum, v) => sum + v.sourceCount, 0);
  const totalItemsTarget = allVerifications.reduce((sum, v) => sum + v.targetCount, 0);
  const totalDiscrepancies = allVerifications.reduce(
    (sum, v) => sum + v.missingOnTarget + v.extraOnTarget,
    0
  );
  const totalBytesTransferred = allVerifications.reduce(
    (sum, v) => sum + v.totalBytesTarget,
    0
  );
  
  return {
    tenantId,
    mappingId,
    timestamp: new Date().toISOString(),
    overallStatus,
    score,
    mail,
    calendar,
    contacts,
    files,
    totalItemsSource,
    totalItemsTarget,
    totalDiscrepancies,
    totalBytesTransferred,
    canProceedToCutover: overallStatus === 'PASS' || (overallStatus === 'WARN' && score >= 0.95),
    recommendations,
  };
}

/**
 * Verify a single data type
 */
async function verifyDataType(
  deps: VerificationDeps & { dataType: 'mail' | 'calendar' | 'contacts' | 'files' }
): Promise<DataTypeVerification> {
  const { dataType, config } = deps;
  
  // Get counts
  const sourceCount = await deps.getSourceCount(dataType);
  const targetCount = await deps.getTargetCount(dataType);
  
  // Find discrepancies
  const missingOnTarget = await deps.findMissingOnTarget(dataType);
  const extraOnTarget = await deps.findExtraOnTarget(dataType);
  
  // Calculate matched count
  const matchedCount = Math.min(sourceCount, targetCount) - missingOnTarget.length - extraOnTarget.length;
  
  // Sample-based checksum verification
  const sampleSize = calculateSampleSize(sourceCount, config);
  const sourceSamples = await deps.getSourceSamples(dataType, sampleSize);
  const targetSamples = await deps.getTargetSamples(dataType, sampleSize);
  
  // Create a map of target samples by naturalKeyHash for efficient lookup
  const targetSamplesByHash = new Map<string, { id: string; content: Uint8Array | string }>();
  for (const sample of targetSamples) {
    targetSamplesByHash.set(sample.naturalKeyHash, { id: sample.id, content: sample.content });
  }
  
  let checksumMatches = 0;
  let checksumMismatches = 0;
  
  // Compare samples by matching naturalKeyHash
  for (const sourceSample of sourceSamples) {
    const targetSample = targetSamplesByHash.get(sourceSample.naturalKeyHash);
    
    if (targetSample) {
      // Found matching natural key hash, compare content
      if (compareContent(sourceSample.content, targetSample.content)) {
        checksumMatches++;
      } else {
        checksumMismatches++;
      }
    } else {
      // Natural key hash not found on target - this is a missing item
      // Count as a mismatch for checksum purposes
      checksumMismatches++;
    }
  }
  
  // Get bytes
  const totalBytesSource = await deps.getTotalBytesSource(dataType);
  const totalBytesTarget = await deps.getTotalBytesTarget(dataType);
  
  // Determine status
  const matchPercentage = sourceCount > 0 ? (matchedCount / sourceCount) : 1;
  const checksumMatchPercentage = 
    (checksumMatches + checksumMismatches) > 0 
      ? checksumMatches / (checksumMatches + checksumMismatches)
      : 1;
  
  const status = determineVerificationStatus(
    matchPercentage,
    checksumMatchPercentage,
    missingOnTarget.length,
    extraOnTarget.length,
    config
  );
  
  // Generate issues
  const issues: DataTypeVerification['issues'] = [];
  
  if (missingOnTarget.length > 0) {
    issues.push({
      id: `MISSING_${dataType}`,
      severity: missingOnTarget.length > sourceCount * config.maxDiscrepancyPercentage ? 'ERROR' : 'WARNING',
      message: `${missingOnTarget.length} ${dataType} item(s) missing on target`,
    });
  }
  
  if (extraOnTarget.length > 0) {
    issues.push({
      id: `EXTRA_${dataType}`,
      severity: 'WARNING',
      message: `${extraOnTarget.length} ${dataType} item(s) exist on target but not source`,
    });
  }
  
  if (checksumMismatches > 0) {
    issues.push({
      id: `CHECKSUM_${dataType}`,
      severity: 'ERROR',
      message: `${checksumMismatches} ${dataType} item(s) have content mismatches`,
    });
  }
  
  return {
    dataType,
    status,
    sourceCount,
    targetCount,
    matchedCount,
    missingOnTarget: missingOnTarget.length,
    extraOnTarget: extraOnTarget.length,
    checksumSampleSize: sampleSize,
    checksumMatches,
    checksumMismatches,
    totalBytesSource,
    totalBytesTarget,
    issues,
  };
}

/**
 * Calculate sample size for checksum verification
 */
function calculateSampleSize(totalCount: number, config: VerificationConfig): number {
  if (totalCount === 0) return 0;
  
  const calculated = Math.floor(totalCount * (config.checksumSamplePercentage / 100));
  return Math.max(
    config.minSampleSize,
    Math.min(calculated, config.maxSampleSize)
  );
}

/**
 * Compare two content pieces
 */
function compareContent(
  a: Uint8Array | string,
  b: Uint8Array | string
): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    return a === b;
  }
  
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
  
  return false;
}

/**
 * Determine verification status based on metrics
 */
function determineVerificationStatus(
  matchPercentage: number,
  checksumMatchPercentage: number,
  missingCount: number,
  extraCount: number,
  config: VerificationConfig
): 'PASS' | 'WARN' | 'FAIL' {
  const totalDiscrepancies = missingCount + extraCount;
  const discrepancyPercentage = totalDiscrepancies / (matchPercentage > 0 ? 1 : 1);
  
  if (
    matchPercentage >= config.requiredMatchPercentage &&
    checksumMatchPercentage >= config.requiredMatchPercentage &&
    discrepancyPercentage <= config.maxDiscrepancyPercentage
  ) {
    return 'PASS';
  }
  
  if (
    matchPercentage >= 0.95 &&
    checksumMatchPercentage >= 0.95 &&
    discrepancyPercentage <= config.maxDiscrepancyPercentage * 2
  ) {
    return 'WARN';
  }
  
  return 'FAIL';
}

/**
 * Calculate overall verification status
 */
function calculateOverallStatus(
  verifications: DataTypeVerification[]
): 'PASS' | 'WARN' | 'FAIL' {
  const hasFail = verifications.some(v => v.status === 'FAIL');
  const hasWarn = verifications.some(v => v.status === 'WARN');
  
  if (hasFail) return 'FAIL';
  if (hasWarn) return 'WARN';
  return 'PASS';
}

/**
 * Calculate overall verification score
 */
function calculateVerificationScore(verifications: DataTypeVerification[]): number {
  if (verifications.length === 0) return 1;
  
  const totalScore = verifications.reduce((sum, v) => {
    const matchRatio = v.sourceCount > 0 ? v.matchedCount / v.sourceCount : 1;
    const checksumRatio = 
      (v.checksumMatches + v.checksumMismatches) > 0
        ? v.checksumMatches / (v.checksumMatches + v.checksumMismatches)
        : 1;
    return sum + (matchRatio * 0.7 + checksumRatio * 0.3);
  }, 0);
  
  return totalScore / verifications.length;
}

/**
 * Generate recommendations based on verification results
 */
function generateRecommendations(
  verifications: DataTypeVerification[],
  overallStatus: 'PASS' | 'WARN' | 'FAIL'
): string[] {
  const recommendations: string[] = [];
  
  if (overallStatus === 'FAIL') {
    recommendations.push('Fix all errors before proceeding to cutover');
    recommendations.push('Review verification report for specific issues');
  }
  
  if (overallStatus === 'WARN') {
    recommendations.push('Review warnings and decide if cutover should proceed');
    recommendations.push('Consider additional verification for flagged items');
  }
  
  verifications.forEach(v => {
    if (v.missingOnTarget > 0) {
      recommendations.push(
        `Re-sync ${v.missingOnTarget} missing ${v.dataType} item(s)`
      );
    }
    
    if (v.checksumMismatches > 0) {
      recommendations.push(
        `Investigate ${v.checksumMismatches} content mismatches in ${v.dataType}`
      );
    }
  });
  
  if (recommendations.length === 0) {
    recommendations.push('All verifications passed. Ready for cutover.');
  }
  
  return recommendations;
}
