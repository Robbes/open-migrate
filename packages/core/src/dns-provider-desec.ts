/**
 * deSEC DNS Provider Adapter
 * 
 * Implements the DnsProvider interface using deSEC's REST API.
 * deSEC is an EU-based free DNS hosting service with a clean REST API.
 * 
 * See: https://desec.io/api/v1/
 */

import type { DnsProvider, DnsRecord } from './dns-manager';

/** deSEC API types */
interface DesecRRset {
  name: string;
  type: string;
  ttl: number;
  records: string[];
}

/** deSEC API record type (internal use) */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface DesecRecord {
  subdomain: string;
  type: string;
  name: string;
  ttl: number;
  records: string[];
  created: string;
  modified: string;
}

/** deSEC provider configuration */
export interface DesecConfig {
  /** deSEC API token */
  token: string;
  /** Base API URL (default: https://desec.io/api/v1) */
  baseUrl?: string;
  /** Dry run mode - don't make actual changes */
  dryRun?: boolean;
}

/** DNS record change operation */
export interface DnsChange {
  action: 'add' | 'remove' | 'update';
  record: DnsRecord;
}

/**
 * deSEC DNS provider implementation
 */
export class DesecProvider implements DnsProvider {
  private readonly config: DesecConfig;
  private readonly baseUrl: string;

  constructor(config: DesecConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl ?? 'https://desec.io/api/v1';
  }

  /**
   * Get all DNS records for a domain
   */
  async getRecords(domain: string): Promise<DnsRecord[]> {
    const response = await this.desecRequest(
      'GET',
      `/v1/domains/${encodeURIComponent(domain)}/rrsets/`
    );

    const records: DnsRecord[] = [];
    
    for (const rrset of response as DesecRRset[]) {
      const name = rrset.name === domain ? '@' : rrset.name.replace(`.${domain}`, '');
      
      for (const recordValue of rrset.records) {
        records.push({
          type: rrset.type as DnsRecord['type'],
          name,
          value: recordValue,
          ttl: rrset.ttl,
          priority: this.extractPriority(rrset.type, recordValue),
        });
      }
    }

    return records;
  }

  /**
   * Update DNS records
   */
  async updateRecords(records: DnsRecord[]): Promise<void> {
    if (this.config.dryRun) {
      console.log('[DRY RUN] Would update DNS records:');
      records.forEach(r => {
        console.log(`  ${r.type} ${r.name} ${r.value} TTL=${r.ttl}${r.priority ? ` Priority=${r.priority}` : ''}`);
      });
      return;
    }

    // Group records by type and name
    const rrsets: Record<string, DesecRRset> = {};

    for (const record of records) {
      const key = `${record.name}:${record.type}`;
      
      if (!rrsets[key]) {
        rrsets[key] = {
          name: record.name === '@' ? this.getFullDomain(record.name) : record.name,
          type: record.type,
          ttl: record.ttl,
          records: [],
        };
      }
      
      // For MX records, format with priority
      if (record.type === 'MX' && record.priority !== undefined) {
        rrsets[key].records.push(`${record.priority} ${record.value}`);
      } else {
        rrsets[key].records.push(record.value);
      }
    }

    // Update each RRset
    for (const rrset of Object.values(rrsets)) {
      await this.desecRequest(
        'PUT',
        `/v1/domains/${encodeURIComponent(this.getFullDomain('@'))}/rrsets/${encodeURIComponent(rrset.name)}/${rrset.type}/`,
        rrset
      );
    }
  }

  /**
   * Verify DNS propagation
   */
  async verifyPropagation(domain: string, expectedRecords: DnsRecord[]): Promise<boolean> {
    // For deSEC, we assume propagation is immediate since we're the authoritative provider
    // In production, you might want to check with a public resolver
    const currentRecords = await this.getRecords(domain);
    
    for (const expected of expectedRecords) {
      const found = currentRecords.some(
        r => 
          r.type === expected.type &&
          r.name === expected.name &&
          r.value === expected.value &&
          (r.priority === expected.priority || !expected.priority)
      );
      
      if (!found) {
        return false;
      }
    }
    
    return true;
  }

  /**
   * Get current DNS state for rollback
   */
  async getCurrentState(domain: string): Promise<DesecRRset[]> {
    const response = await this.desecRequest(
      'GET',
      `/v1/domains/${encodeURIComponent(domain)}/rrsets/`
    );
    return response as DesecRRset[];
  }

  /**
   * Restore DNS state (rollback)
   */
  async restoreState(domain: string, rrsets: DesecRRset[]): Promise<void> {
    if (this.config.dryRun) {
      console.log('[DRY RUN] Would restore DNS state to:');
      rrsets.forEach(rrset => {
        console.log(`  ${rrset.type} ${rrset.name}: ${rrset.records.join(', ')}`);
      });
      return;
    }

    for (const rrset of rrsets) {
      await this.desecRequest(
        'PUT',
        `/v1/domains/${encodeURIComponent(domain)}/rrsets/${encodeURIComponent(rrset.name)}/${rrset.type}/`,
        rrset
      );
    }
  }

  /**
   * Dry run - calculate what changes would be made
   */
  async dryRun(domain: string, newRecords: DnsRecord[]): Promise<{
    additions: DnsChange[];
    removals: DnsChange[];
    updates: DnsChange[];
  }> {
    const current = await this.getRecords(domain);
    
    const additions: DnsChange[] = [];
    const removals: DnsChange[] = [];
    const updates: DnsChange[] = [];

    // Find additions and updates
    for (const newRecord of newRecords) {
      const matching = current.filter(
        r => r.type === newRecord.type && r.name === newRecord.name
      );
      
      if (matching.length === 0) {
        additions.push({ action: 'add', record: newRecord });
      } else {
        const existing = matching[0];
        if (existing.value !== newRecord.value || existing.ttl !== newRecord.ttl) {
          updates.push({ action: 'update', record: newRecord });
        }
      }
    }

    // Find removals
    for (const currentRecord of current) {
      const matching = newRecords.filter(
        r => r.type === currentRecord.type && r.name === currentRecord.name && r.value === currentRecord.value
      );
      
      if (matching.length === 0) {
        removals.push({ action: 'remove', record: currentRecord });
      }
    }

    return { additions, removals, updates };
  }

  // Helper methods

  private getFullDomain(name: string): string {
    return name === '@' ? this.config.token.split('.')[0] : `${name}.`;
  }

  private extractPriority(recordType: string, value: string): number | undefined {
    if (recordType === 'MX') {
      const match = value.match(/^(\d+)\s+/);
      return match ? parseInt(match[1], 10) : undefined;
    }
    return undefined;
  }

  private async desecRequest(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    
    const options: RequestInit = {
      method,
      headers: {
        'Authorization': `Token ${this.config.token}`,
        'Content-Type': 'application/json',
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`deSEC API error (${response.status}): ${errorText}`);
    }

    if (method === 'DELETE' || response.status === 204) {
      return undefined;
    }

    return response.json();
  }
}

/**
 * Create a deSEC provider with environment variable configuration
 */
export function createDesecProvider(): DesecProvider {
  const token = process.env.DESEC_TOKEN;
  
  if (!token) {
    throw new Error('DESEC_TOKEN environment variable is required');
  }

  return new DesecProvider({
    token,
    dryRun: process.env.DESEC_DRY_RUN === 'true',
  });
}
