/**
 * DNS Manager
 * 
 * Manages DNS records for cutover, including MX, TXT, SPF, DKIM, DMARC,
 * and autodiscover records. Provides propagation verification and rollback.
 */

import type { TenantId, MappingId } from '@openmig/shared';

/** DNS record types */
export type DnsRecordType = 'MX' | 'TXT' | 'A' | 'CNAME' | 'NS';

/** DNS record */
export interface DnsRecord {
  type: DnsRecordType;
  name: string;
  value: string;
  ttl: number;
  priority?: number; // For MX records
}

/** DNS provider interface */
export interface DnsProvider {
  /** Get all DNS records for a domain */
  getRecords(domain: string): Promise<DnsRecord[]>;
  
  /** Update DNS records */
  updateRecords(records: DnsRecord[]): Promise<void>;
  
  /** Verify DNS propagation */
  verifyPropagation(domain: string, expectedRecords: DnsRecord[]): Promise<boolean>;
}

/** DNS configuration for cutover */
export interface DnsConfig {
  /** Target domain */
  domain: string;
  
  /** MX record priority and target */
  mxRecords: Array<{ priority: number; target: string }>;
  
  /** SPF record value */
  spfRecord: string;
  
  /** DKIM selector and public key */
  dkimRecords?: Array<{ selector: string; publicKey: string }>;
  
  /** DMARC policy */
  dmarcRecord?: {
    policy: 'none' | 'quarantine' | 'reject';
    subdomainPolicy?: 'none' | 'quarantine' | 'reject';
    rua?: string; // Report URI
    ruf?: string; // Failure URI
  };
  
  /** Autodiscover CNAME or A record */
  autodiscoverRecord?: {
    type: 'CNAME' | 'A';
    value: string;
  };
  
  /** TTL for all records */
  ttl: number;
}

/** DNS migration status */
export interface DnsMigrationStatus {
  tenantId: TenantId;
  mappingId: MappingId;
  domain: string;
  phase: 'NOT_STARTED' | 'IN_PROGRESS' | 'VERIFIED' | 'FAILED';
  records: DnsRecord[];
  verifiedRecords: string[];
  failedRecords: string[];
  startedAt?: Date;
  completedAt?: Date;
  verifiedAt?: Date;
}

/** DNS migration result */
export interface DnsMigrationResult {
  success: boolean;
  recordsUpdated: number;
  recordsVerified: number;
  failedRecords: string[];
  warnings: string[];
}

/** DNS manager dependencies */
export interface DnsManagerDeps {
  /** Get DNS provider */
  getProvider(domain: string): Promise<DnsProvider>;
  
  /** Get current DNS status */
  getStatus(tenantId: TenantId, mappingId: MappingId): Promise<DnsMigrationStatus | undefined>;
  
  /** Update DNS status */
  setStatus(status: DnsMigrationStatus): Promise<void>;
  
  /** Log DNS migration event */
  logEvent(tenantId: TenantId, mappingId: string, event: string, details?: Record<string, unknown>): Promise<void>;
}

/** DNS manager */
export class DnsManager {
  private readonly deps: DnsManagerDeps;
  private readonly config: DnsConfig;

  constructor(deps: DnsManagerDeps, config: DnsConfig) {
    this.deps = deps;
    this.config = config;
  }

  /**
   * Prepare DNS records for migration
   */
  async prepare(tenantId: TenantId, mappingId: MappingId): Promise<DnsMigrationStatus> {
    const records = this.buildDnsRecords();
    
    const status: DnsMigrationStatus = {
      tenantId,
      mappingId,
      domain: this.config.domain,
      phase: 'NOT_STARTED',
      records,
      verifiedRecords: [],
      failedRecords: [],
      startedAt: new Date(),
    };

    await this.deps.setStatus(status);
    await this.deps.logEvent(tenantId, mappingId, 'DNS_PREPARED', {
      recordCount: records.length,
      domain: this.config.domain,
    });

    return status;
  }

  /**
   * Execute DNS migration
   */
  async execute(tenantId: TenantId, mappingId: MappingId): Promise<DnsMigrationResult> {
    const records = this.buildDnsRecords();
    
    const provider = await this.deps.getProvider(this.config.domain);
    
    try {
      await provider.updateRecords(records);
      
      await this.deps.logEvent(tenantId, mappingId, 'DNS_UPDATED', {
        recordCount: records.length,
      });

      // Update status
      const status = await this.deps.getStatus(tenantId, mappingId);
      if (status) {
        status.phase = 'IN_PROGRESS';
        status.records = records;
        await this.deps.setStatus(status);
      }

      return {
        success: true,
        recordsUpdated: records.length,
        recordsVerified: 0,
        failedRecords: [],
        warnings: ['DNS propagation may take time'],
      };
    } catch (error) {
      await this.deps.logEvent(tenantId, mappingId, 'DNS_FAILED', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return {
        success: false,
        recordsUpdated: 0,
        recordsVerified: 0,
        failedRecords: records.map(r => `${r.type}:${r.name}`),
        warnings: [],
      };
    }
  }

  /**
   * Verify DNS propagation
   */
  async verify(tenantId: TenantId, mappingId: MappingId, maxAttempts = 10, delayMs = 30000): Promise<DnsMigrationResult> {
    const records = this.buildDnsRecords();
    const provider = await this.deps.getProvider(this.config.domain);
    
    const results: DnsMigrationResult = {
      success: false,
      recordsUpdated: 0,
      recordsVerified: 0,
      failedRecords: [],
      warnings: [],
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const isPropagated = await provider.verifyPropagation(this.config.domain, records);
      
      if (isPropagated) {
        results.success = true;
        results.recordsVerified = records.length;
        
        // Update status
        const status = await this.deps.getStatus(tenantId, mappingId);
        if (status) {
          status.phase = 'VERIFIED';
          status.verifiedRecords = records.map(r => `${r.type}:${r.name}`);
          status.verifiedAt = new Date();
          await this.deps.setStatus(status);
        }

        await this.deps.logEvent(tenantId, mappingId, 'DNS_VERIFIED', {
          attempts: attempt,
          delayMs,
        });

        return results;
      }

      // Wait before next attempt
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // Failed to verify
    results.failedRecords = records.map(r => `${r.type}:${r.name}`);
    results.warnings.push(`DNS propagation verification failed after ${maxAttempts} attempts`);

    await this.deps.logEvent(tenantId, mappingId, 'DNS_VERIFICATION_FAILED', {
      attempts: maxAttempts,
    });

    // Update status
    const status = await this.deps.getStatus(tenantId, mappingId);
    if (status) {
      status.phase = 'FAILED';
      status.failedRecords = results.failedRecords;
      await this.deps.setStatus(status);
    }

    return results;
  }

  /**
   * Rollback DNS changes
   */
  async rollback(tenantId: TenantId, mappingId: MappingId, previousRecords: DnsRecord[]): Promise<DnsMigrationResult> {
    const provider = await this.deps.getProvider(this.config.domain);
    
    try {
      await provider.updateRecords(previousRecords);
      
      await this.deps.logEvent(tenantId, mappingId, 'DNS_ROLLBACK', {
        recordsRestored: previousRecords.length,
      });

      // Update status
      const status = await this.deps.getStatus(tenantId, mappingId);
      if (status) {
        status.phase = 'NOT_STARTED';
        status.records = previousRecords;
        status.verifiedRecords = [];
        status.failedRecords = [];
        await this.deps.setStatus(status);
      }

      return {
        success: true,
        recordsUpdated: previousRecords.length,
        recordsVerified: 0,
        failedRecords: [],
        warnings: ['DNS rollback complete'],
      };
    } catch (error) {
      await this.deps.logEvent(tenantId, mappingId, 'DNS_ROLLBACK_FAILED', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      return {
        success: false,
        recordsUpdated: 0,
        recordsVerified: 0,
        failedRecords: previousRecords.map(r => `${r.type}:${r.name}`),
        warnings: [],
      };
    }
  }

  /**
   * Build DNS records from configuration
   */
  private buildDnsRecords(): DnsRecord[] {
    const records: DnsRecord[] = [];

    // MX records
    for (const mx of this.config.mxRecords) {
      records.push({
        type: 'MX',
        name: '@',
        value: mx.target,
        ttl: this.config.ttl,
        priority: mx.priority,
      });
    }

    // SPF record
    records.push({
      type: 'TXT',
      name: '@',
      value: this.config.spfRecord,
      ttl: this.config.ttl,
    });

    // DKIM records
    if (this.config.dkimRecords) {
      for (const dkim of this.config.dkimRecords) {
        records.push({
          type: 'TXT',
          name: `${dkim.selector}._domainkey`,
          value: dkim.publicKey,
          ttl: this.config.ttl,
        });
      }
    }

    // DMARC record
    if (this.config.dmarcRecord) {
      const dmarcValue = [
        `v=DMARC1;`,
        `p=${this.config.dmarcRecord.policy}`,
        this.config.dmarcRecord.subdomainPolicy ? `sp=${this.config.dmarcRecord.subdomainPolicy}` : '',
        this.config.dmarcRecord.rua ? `rua=mailto:${this.config.dmarcRecord.rua}` : '',
        this.config.dmarcRecord.ruf ? `ruf=mailto:${this.config.dmarcRecord.ruf}` : '',
      ].filter(Boolean).join(' ');

      records.push({
        type: 'TXT',
        name: '_dmarc',
        value: dmarcValue,
        ttl: this.config.ttl,
      });
    }

    // Autodiscover record
    if (this.config.autodiscoverRecord) {
      records.push({
        type: this.config.autodiscoverRecord.type,
        name: 'autodiscover',
        value: this.config.autodiscoverRecord.value,
        ttl: this.config.ttl,
      });
    }

    return records;
  }
}

/** Default DNS configuration */
export const DEFAULT_DNS_CONFIG: Partial<DnsConfig> = {
  ttl: 3600, // 1 hour
};
