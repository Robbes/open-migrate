/**
 * DNS Verify-Only Implementation
 * 
 * Provides resolver-based DNS checks that require no credentials.
 * Used for pre-cutover verification and propagation monitoring.
 * 
 * See docs/architecture/solution-architecture.md §11 (DNS switch procedure)
 */

import { promises as dns } from 'dns';

/** DNS verification result */
export interface DnsVerificationResult {
  success: boolean;
  recordType: string;
  expected: string[];
  found: string[];
  missing: string[];
  warnings: string[];
}

/** DNS verification status */
export interface DnsVerificationStatus {
  domain: string;
  mxVerified: boolean;
  spfVerified: boolean;
  dkimVerified: boolean;
  dmarcVerified: boolean;
  autodiscoverVerified: boolean;
  allVerified: boolean;
  verifiedAt?: string;
  errors: string[];
  warnings: string[];
}

/**
 * Verify MX records for a domain
 */
export async function verifyMX(domain: string): Promise<DnsVerificationResult> {
  try {
    const mxRecords = await dns.resolveMx(domain);
    
    const found = mxRecords.map((r) => `${r.priority}:${r.exchange}`);
    const expected: string[] = []; // No specific expected values for verification-only
    
    return {
      success: mxRecords.length > 0,
      recordType: 'MX',
      expected,
      found,
      missing: mxRecords.length === 0 ? ['No MX records found'] : [],
      warnings: mxRecords.length === 0 ? ['Domain has no MX records - mail will not work'] : [],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      recordType: 'MX',
      expected: [],
      found: [],
      missing: ['DNS lookup failed'],
      warnings: [errorMessage],
    };
  }
}

/**
 * Verify SPF record for a domain
 */
export async function verifySPF(domain: string, expectedSender?: string): Promise<DnsVerificationResult> {
  try {
    const txtRecords = await dns.resolveTxt(domain);
    
    // Find SPF records (start with "v=spf1")
    const spfRecords = txtRecords
      .filter((r) => r.length > 0 && r[0].startsWith('v=spf1'))
      .map((r) => r[0]);
    
    const _found = spfRecords;
    const hasSpf = spfRecords.length > 0;
    
    const warnings: string[] = [];
    if (!hasSpf) {
      warnings.push('No SPF record found - domain may not be able to send email');
    } else if (expectedSender && !spfRecords.some((r) => r.includes(expectedSender))) {
      warnings.push(`Expected sender "${expectedSender}" not found in SPF record`);
    }
    
    return {
      success: hasSpf,
      recordType: 'SPF',
      expected: expectedSender ? [`v=spf1 includes ${expectedSender}`] : [],
      found: spfRecords,
      missing: hasSpf ? [] : ['No SPF record found'],
      warnings,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      recordType: 'SPF',
      expected: [],
      found: [],
      missing: ['DNS lookup failed'],
      warnings: [errorMessage],
    };
  }
}

/**
 * Verify DKIM record for a selector
 */
export async function verifyDKIM(domain: string, selector: string): Promise<DnsVerificationResult> {
  try {
    const dkimDomain = `${selector}._domainkey.${domain}`;
    const txtRecords = await dns.resolveTxt(dkimDomain);
    
    const dkimRecords = txtRecords
      .filter((r) => r.length > 0 && r[0].startsWith('v=DKIM1'))
      .map((r) => r[0]);
    
    const _found = dkimRecords;
    const hasDkim = dkimRecords.length > 0;
    
    return {
      success: hasDkim,
      recordType: 'DKIM',
      expected: [`v=DKIM1; k=rsa; p=...`],
      found: dkimRecords,
      missing: hasDkim ? [] : [`No DKIM record found for selector "${selector}"`],
      warnings: hasDkim ? [] : [`DKIM not configured for selector "${selector}"`],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      recordType: 'DKIM',
      expected: [],
      found: [],
      missing: ['DNS lookup failed'],
      warnings: [errorMessage],
    };
  }
}

/**
 * Verify DMARC record for a domain
 */
export async function verifyDMARC(domain: string): Promise<DnsVerificationResult> {
  try {
    const dmarcDomain = `_dmarc.${domain}`;
    const txtRecords = await dns.resolveTxt(dmarcDomain);
    
    const dmarcRecords = txtRecords
      .filter((r) => r.length > 0 && r[0].startsWith('v=DMARC1'))
      .map((r) => r[0]);
    
    const _found = dmarcRecords;
    const hasDmarc = dmarcRecords.length > 0;
    
    // Parse policy if present
    let policy: string | undefined;
    if (hasDmarc) {
      const match = dmarcRecords[0]?.match(/p=(none|quarantine|reject)/);
      policy = match?.[1];
    }
    
    return {
      success: hasDmarc,
      recordType: 'DMARC',
      expected: ['v=DMARC1; p=...'],
      found: dmarcRecords,
      missing: hasDmarc ? [] : ['No DMARC record found'],
      warnings: hasDmarc 
        ? policy === 'none' 
          ? ['DMARC policy is "none" - monitoring mode only']
          : []
        : ['DMARC not configured'],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      recordType: 'DMARC',
      expected: [],
      found: [],
      missing: ['DNS lookup failed'],
      warnings: [errorMessage],
    };
  }
}

/**
 * Verify autodiscover record exists
 */
export async function verifyAutodiscover(domain: string): Promise<DnsVerificationResult> {
  try {
    const autodiscoverDomain = `autodiscover.${domain}`;
    
    // Try to resolve A or CNAME
    try {
      const aRecords = await dns.resolve(autodiscoverDomain, 'A');
      return {
        success: true,
        recordType: 'A',
        expected: [],
        found: aRecords as string[],
        missing: [],
        warnings: [],
      };
    } catch {
      // Try CNAME
      try {
        const cnameRecords = await dns.resolve(autodiscoverDomain, 'CNAME');
        return {
          success: true,
          recordType: 'CNAME',
          expected: [],
          found: cnameRecords as string[],
          missing: [],
          warnings: [],
        };
      } catch {
        return {
          success: false,
          recordType: 'Autodiscover',
          expected: ['autodiscover record'],
          found: [],
          missing: ['No autodiscover record found'],
          warnings: ['Autodiscover not configured - users may need manual client setup'],
        };
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      recordType: 'Autodiscover',
      expected: [],
      found: [],
      missing: ['DNS lookup failed'],
      warnings: [errorMessage],
    };
  }
}

/**
 * Check DNS propagation with polling
 */
export async function checkPropagation(
  domain: string,
  expectedRecords: { type: string; value: string }[],
  maxAttempts: number = 10,
  backoffMs: number = 30000
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let allFound = true;
    
    for (const expected of expectedRecords) {
      try {
        if (expected.type === 'MX') {
          const mxRecords = await dns.resolveMx(domain);
          const found = mxRecords.map((r) => `${r.priority}:${r.exchange}`);
          if (!found.some((f: string) => f.includes(expected.value))) {
            allFound = false;
          }
        } else if (expected.type === 'TXT') {
          const txtRecords = await dns.resolveTxt(domain);
          const found = txtRecords
            .filter((r) => r.length > 0)
            .map((r) => r[0]);
          if (!found.some((f: string) => f.includes(expected.value))) {
            allFound = false;
          }
        }
        // Add more record type checks as needed
      } catch {
        allFound = false;
      }
    }
    
    if (allFound) {
      return true;
    }
    
    // Wait before next attempt with TTL-based backoff
    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
  
  return false;
}

/**
 * Verify all DNS records for cutover
 */
export async function verifyAllDns(domain: string): Promise<DnsVerificationStatus> {
  const [mxResult, spfResult, dmarcResult, autodiscoverResult] = await Promise.all([
    verifyMX(domain),
    verifySPF(domain),
    verifyDMARC(domain),
    verifyAutodiscover(domain),
  ]);
  
  const errors: string[] = [];
  const warnings: string[] = [];
  
  if (!mxResult.success) {
    errors.push(...mxResult.warnings);
  } else {
    warnings.push(...mxResult.warnings);
  }
  
  if (!spfResult.success) {
    errors.push(...spfResult.warnings);
  } else {
    warnings.push(...spfResult.warnings);
  }
  
  if (!dmarcResult.success) {
    errors.push(...dmarcResult.warnings);
  } else {
    warnings.push(...dmarcResult.warnings);
  }
  
  if (!autodiscoverResult.success) {
    warnings.push(...autodiscoverResult.warnings);
  }
  
  const allVerified = mxResult.success && spfResult.success && dmarcResult.success;
  
  return {
    domain,
    mxVerified: mxResult.success,
    spfVerified: spfResult.success,
    dkimVerified: false, // DKIM requires selector
    dmarcVerified: dmarcResult.success,
    autodiscoverVerified: autodiscoverResult.success,
    allVerified,
    verifiedAt: allVerified ? new Date().toISOString() : undefined,
    errors,
    warnings,
  };
}

/**
 * Generate DNS runbook for manual implementation
 */
export function generateDnsRunbook(
  domain: string,
  targetMailServer: string,
  targetIp?: string
): string {
  const lines: string[] = [
    `# DNS Migration Runbook for ${domain}`,
    `# Generated: ${new Date().toISOString()}`,
    ``,
    `## Before Cutover`,
    ``,
    `### 1. Lower TTLs (24 hours before)`,
    `Change TTL for MX, TXT (SPF/DMARC) records to 300 seconds`,
    ``,
    `## During Cutover`,
    ``,
    `### 2. Update MX Records`,
    `- Delete existing MX records`,
    `- Add new MX record:`,
    `  - Type: MX`,
    `  - Name: @`,
    `  - Value: ${targetMailServer}`,
    `  - Priority: 10`,
    `  - TTL: 300`,
    ``,
    `### 3. Update SPF Record`,
    `- Update TXT record for @:`,
    `  - Value: v=spf1 mx include:${targetMailServer} ~all`,
    ``,
    `### 4. Add DMARC Record`,
    `- Add TXT record for _dmarc:`,
    `  - Value: v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}`,
    ``,
    `### 5. Update Autodiscover (if applicable)`,
    `- Add CNAME or A record for autodiscover:`,
    `  - Name: autodiscover`,
    `  - Value: ${targetIp || targetMailServer}`,
    ``,
    `## After Cutover`,
    ``,
    `### 6. Verify Propagation`,
    `- Run: dig MX ${domain}`,
    `- Run: dig TXT ${domain}`,
    `- Run: dig TXT _dmarc.${domain}`,
    ``,
    `### 7. Restore TTLs`,
    `After 48 hours, restore original TTL values`,
    ``,
    `## Rollback Procedure`,
    ``,
    `If issues occur, restore previous DNS records:`,
    `- Revert MX records to original values`,
    `- Revert SPF record to original value`,
    `- DMARC can remain as-is (monitoring mode)`,
    ``,
  ];
  
  return lines.join('\n');
}
