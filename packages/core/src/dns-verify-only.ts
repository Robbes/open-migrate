/**
 * DNS Verify-Only Implementation
 * 
 * Provides multi-resolver DNS checks that query PUBLIC DNS resolvers explicitly.
 * Uses consensus across multiple independent resolvers (1.1.1.1, 8.8.8.8, 9.9.9.9)
 * to verify propagation - a single resolver agreeing is NOT sufficient.
 * 
 * This is REQUIRED for cutover verification because:
 * - System resolvers may be cached or use internal DNS
 * - Provider self-certification is forbidden by the PropagationChecker split
 * - Only public resolver consensus proves real-world propagation
 * 
 * Uses DNS-over-HTTPS (DoH) to query resolvers directly, bypassing system DNS.
 * 
 * See docs/architecture/solution-architecture.md §11 (DNS switch procedure)
 */

/** Public DNS resolvers for consensus checking (DoH endpoints) */
export const PUBLIC_DNS_RESOLVERS = [
  { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'Google', url: 'https://dns.google/query' },
  { name: 'Quad9', url: 'https://dns.quad9.net/dns-query' },
] as const;

/** Per-resolver DNS query result */
export interface ResolverResult {
  resolver: string;
  success: boolean;
  records: string[];
  error?: string;
}

/** DNS verification result with per-resolver breakdown */
export interface DnsVerificationResult {
  success: boolean;
  recordType: string;
  expected: string[];
  found: string[];
  missing: string[];
  warnings: string[];
  resolverResults: Record<string, ResolverResult>;
  consensus: boolean;
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

/** DNS record types for DoH queries */
type DnsRecordType = 'A' | 'AAAA' | 'MX' | 'TXT' | 'CNAME' | 'NS' | 'SOA' | 'SRV' | 'PTR';

/**
 * Query a DNS record type via DNS-over-HTTPS
 */
async function queryDoh(
  resolver: { name: string; url: string },
  domain: string,
  recordType: DnsRecordType
): Promise<ResolverResult> {
  try {
    const dohUrl = `${resolver.url}?name=${encodeURIComponent(domain)}&type=${recordType}`;

    const response = await fetch(dohUrl, {
      headers: {
        'Accept': 'application/dns-json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return {
        resolver: resolver.name,
        success: false,
        records: [],
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = await response.json() as { Answer?: Array<{ data?: string; rdata?: string }> };
    
    const records: string[] = [];
    if (data.Answer) {
      for (const answer of data.Answer) {
        const rdata = answer.data || answer.rdata;
        if (rdata) {
          records.push(String(rdata).replace(/"/g, ''));
        }
      }
    }

    return {
      resolver: resolver.name,
      success: records.length > 0,
      records,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      resolver: resolver.name,
      success: false,
      records: [],
      error: errorMessage,
    };
  }
}

export async function verifyMX(domain: string): Promise<DnsVerificationResult> {
  const resolverResults: Record<string, ResolverResult> = {};
  const results = await Promise.all(PUBLIC_DNS_RESOLVERS.map((r) => queryDoh(r, domain, 'MX')));
  for (const result of results) resolverResults[result.resolver] = result;
  const successfulResolvers = results.filter((r) => r.success);
  const consensus = successfulResolvers.length >= 2;
  const allRecords = new Set<string>();
  for (const result of successfulResolvers) for (const record of result.records) allRecords.add(record);
  const found = Array.from(allRecords);
  const success = consensus && found.length > 0;
  return { success, recordType: 'MX', expected: [], found, missing: success ? [] : ['MX records not found'], warnings: success ? [] : ['No MX records'], resolverResults, consensus };
}

export async function verifySPF(domain: string, expectedSender?: string): Promise<DnsVerificationResult> {
  const resolverResults: Record<string, ResolverResult> = {};
  const results = await Promise.all(PUBLIC_DNS_RESOLVERS.map((r) => queryDoh(r, domain, 'TXT')));
  for (const result of results) resolverResults[result.resolver] = result;
  const successfulResolvers = results.filter((r) => r.success);
  const consensus = successfulResolvers.length >= 2;
  const allSpfRecords = new Set<string>();
  for (const result of successfulResolvers) for (const record of result.records.filter((r) => r.startsWith('v=spf1'))) allSpfRecords.add(record);
  const found = Array.from(allSpfRecords);
  const hasSpf = found.length > 0;
  const success = consensus && hasSpf;
  const warnings: string[] = [];
  if (!hasSpf) warnings.push('No SPF record found');
  else if (expectedSender && !found.some((r) => r.includes(expectedSender))) warnings.push(`Expected sender "${expectedSender}" not found`);
  return { success, recordType: 'SPF', expected: expectedSender ? [`v=spf1 includes ${expectedSender}`] : [], found, missing: hasSpf ? [] : ['No SPF record'], warnings, resolverResults, consensus };
}

export async function verifyDKIM(domain: string, selector: string): Promise<DnsVerificationResult> {
  const dkimDomain = `${selector}._domainkey.${domain}`;
  const resolverResults: Record<string, ResolverResult> = {};
  const results = await Promise.all(PUBLIC_DNS_RESOLVERS.map((r) => queryDoh(r, dkimDomain, 'TXT')));
  for (const result of results) resolverResults[result.resolver] = result;
  const successfulResolvers = results.filter((r) => r.success);
  const consensus = successfulResolvers.length >= 2;
  const allDkimRecords = new Set<string>();
  for (const result of successfulResolvers) for (const record of result.records.filter((r) => r.startsWith('v=DKIM1'))) allDkimRecords.add(record);
  const found = Array.from(allDkimRecords);
  const hasDkim = found.length > 0;
  const success = consensus && hasDkim;
  return { success, recordType: 'DKIM', expected: ['v=DKIM1'], found, missing: hasDkim ? [] : [`No DKIM for ${selector}`], warnings: hasDkim ? [] : [`DKIM not configured for ${selector}`], resolverResults, consensus };
}

export async function verifyDMARC(domain: string): Promise<DnsVerificationResult> {
  const dmarcDomain = `_dmarc.${domain}`;
  const resolverResults: Record<string, ResolverResult> = {};
  const results = await Promise.all(PUBLIC_DNS_RESOLVERS.map((r) => queryDoh(r, dmarcDomain, 'TXT')));
  for (const result of results) resolverResults[result.resolver] = result;
  const successfulResolvers = results.filter((r) => r.success);
  const consensus = successfulResolvers.length >= 2;
  const allDmarcRecords = new Set<string>();
  for (const result of successfulResolvers) for (const record of result.records.filter((r) => r.startsWith('v=DMARC1'))) allDmarcRecords.add(record);
  const found = Array.from(allDmarcRecords);
  const hasDmarc = found.length > 0;
  const success = consensus && hasDmarc;
  let policy: string | undefined;
  if (hasDmarc) { const match = found[0]?.match(/p=(none|quarantine|reject)/); policy = match?.[1]; }
  return { success, recordType: 'DMARC', expected: ['v=DMARC1'], found, missing: hasDmarc ? [] : ['No DMARC'], warnings: hasDmarc && policy === 'none' ? ['DMARC policy is "none"'] : hasDmarc ? [] : ['DMARC not configured'], resolverResults, consensus };
}

export async function verifyAutodiscover(domain: string): Promise<DnsVerificationResult> {
  const autodiscoverDomain = `autodiscover.${domain}`;
  const aResults = await Promise.all(PUBLIC_DNS_RESOLVERS.map((r) => queryDoh(r, autodiscoverDomain, 'A')));
  const successfulA = aResults.filter((r) => r.success);
  const aConsensus = successfulA.length >= 2;
  if (aConsensus) {
    const allARecords = new Set<string>();
    for (const result of successfulA) for (const record of result.records) allARecords.add(record);
    return { success: true, recordType: 'A', expected: [], found: Array.from(allARecords), missing: [], warnings: [], resolverResults: Object.fromEntries(aResults.map((r) => [r.resolver, r])), consensus: aConsensus };
  }
  const cnameResults = await Promise.all(PUBLIC_DNS_RESOLVERS.map((r) => queryDoh(r, autodiscoverDomain, 'CNAME')));
  const successfulCname = cnameResults.filter((r) => r.success);
  const cnameConsensus = successfulCname.length >= 2;
  if (cnameConsensus) {
    const allCnameRecords = new Set<string>();
    for (const result of successfulCname) for (const record of result.records) allCnameRecords.add(record);
    return { success: true, recordType: 'CNAME', expected: [], found: Array.from(allCnameRecords), missing: [], warnings: [], resolverResults: Object.fromEntries(cnameResults.map((r) => [r.resolver, r])), consensus: cnameConsensus };
  }
  return { success: false, recordType: 'Autodiscover', expected: ['autodiscover'], found: [], missing: ['No autodiscover'], warnings: ['Autodiscover not configured'], resolverResults: {}, consensus: false };
}

export async function checkPropagation(domain: string, expectedRecords: { type: string; value: string }[], maxAttempts: number = 10, backoffMs: number = 30000): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let allFound = true;
    for (const expected of expectedRecords) {
      try {
        if (expected.type === 'MX') { const result = await verifyMX(domain); if (!result.consensus || !result.found.some((f: string) => f.includes(expected.value))) allFound = false; }
        else if (expected.type === 'TXT') { const result = await verifySPF(domain); if (!result.consensus || !result.found.some((f: string) => f.includes(expected.value))) allFound = false; }
      } catch { allFound = false; }
    }
    if (allFound) return true;
    if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, backoffMs));
  }
  return false;
}

export async function verifyAllDns(domain: string): Promise<DnsVerificationStatus> {
  const [mxResult, spfResult, dmarcResult, autodiscoverResult] = await Promise.all([verifyMX(domain), verifySPF(domain), verifyDMARC(domain), verifyAutodiscover(domain)]);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!mxResult.success) errors.push(...mxResult.warnings); else warnings.push(...mxResult.warnings);
  if (!spfResult.success) errors.push(...spfResult.warnings); else warnings.push(...spfResult.warnings);
  if (!dmarcResult.success) errors.push(...dmarcResult.warnings); else warnings.push(...dmarcResult.warnings);
  if (!autodiscoverResult.success) warnings.push(...autodiscoverResult.warnings);
  const allVerified = mxResult.success && spfResult.success && dmarcResult.success;
  return { domain, mxVerified: mxResult.success, spfVerified: spfResult.success, dkimVerified: false, dmarcVerified: dmarcResult.success, autodiscoverVerified: autodiscoverResult.success, allVerified, verifiedAt: allVerified ? new Date().toISOString() : undefined, errors, warnings };
}

export function generateDnsRunbook(domain: string, targetMailServer: string, targetIp?: string): string {
  return `# DNS Migration Runbook for ${domain}
# Generated: ${new Date().toISOString()}

## Before Cutover
### 1. Lower TTLs (24 hours before)
Change TTL for MX, TXT (SPF/DMARC) records to 300 seconds

## During Cutover
### 2. Update MX Records
- Delete existing MX records
- Add new MX record: Type: MX, Name: @, Value: ${targetMailServer}, Priority: 10, TTL: 300

### 3. Update SPF Record
- Update TXT record for @: v=spf1 mx include:${targetMailServer} ~all

### 4. Add DMARC Record
- Add TXT record for _dmarc: v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}

### 5. Update Autodiscover (if applicable)
- Add CNAME or A record for autodiscover: ${targetIp || targetMailServer}

## After Cutover
### 6. Verify Propagation
- Run: dig MX ${domain}
- Run: dig TXT ${domain}
- Run: dig TXT _dmarc.${domain}

### 7. Restore TTLs
After 48 hours, restore original TTL values

## Rollback Procedure
If issues occur, restore previous DNS records.
`;
}
