/**
 * DNS Manager Unit Tests
 * 
 * Tests for DNS record management, propagation verification, and rollback.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { asTenantId, asMappingId } from '@openmig/shared';
import {
  DnsManager,
  type DnsConfig,
  type DnsRecord,
  type DnsProvider,
  type DnsMigrationStatus,
} from '../src/dns-manager';

// Mock DNS provider
class MockDnsProvider implements DnsProvider {
  private records: DnsRecord[] = [];
  private verifyDelay = 0;
  private shouldFail = false;

  async getRecords(_domain: string): Promise<DnsRecord[]> {
    return this.records;
  }

  async updateRecords(records: DnsRecord[]): Promise<void> {
    if (this.shouldFail) {
      throw new Error('DNS update failed');
    }
    this.records = records;
  }

  async verifyPropagation(_domain: string, _expectedRecords: DnsRecord[]): Promise<boolean> {
    if (this.verifyDelay > 0) {
      this.verifyDelay--;
      return false;
    }
    return true;
  }

  setShouldFail(fail: boolean): void {
    this.shouldFail = fail;
  }

  setVerifyDelay(delay: number): void {
    this.verifyDelay = delay;
  }
}

// Mock dependencies
function createMockDeps(provider: MockDnsProvider) {
  const statuses = new Map<string, DnsMigrationStatus>();
  const events: Array<{ tenantId: string; mappingId: string; event: string; details?: Record<string, unknown> }> = [];

  return {
    async getProvider(_domain: string): Promise<DnsProvider> {
      return provider;
    },
    async getStatus(tenantId: string, mappingId: string): Promise<DnsMigrationStatus | undefined> {
      const key = `${tenantId}:${mappingId}`;
      return statuses.get(key);
    },
    async setStatus(status: DnsMigrationStatus): Promise<void> {
      const key = `${status.tenantId}:${status.mappingId}`;
      statuses.set(key, status);
    },
    async logEvent(tenantId: string, mappingId: string, event: string, details?: Record<string, unknown>): Promise<void> {
      events.push({ tenantId, mappingId, event, details });
    },
    getEvents() {
      return events;
    },
  };
}

describe('DnsManager', () => {
  const domain = 'example.com';
  const config: DnsConfig = {
    domain,
    mxRecords: [
      { priority: 10, target: 'mail.example.com' },
      { priority: 20, target: 'mail2.example.com' },
    ],
    spfRecord: 'v=spf1 include:_spf.example.com ~all',
    dkimRecords: [
      { selector: 'default', publicKey: 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC...' },
    ],
    dmarcRecord: {
      policy: 'quarantine',
      subdomainPolicy: 'none',
      rua: 'dmarc@example.com',
    },
    autodiscoverRecord: {
      type: 'CNAME',
      value: 'autodiscover.example.com',
    },
    ttl: 3600,
  };

  let provider: MockDnsProvider;
  let deps: ReturnType<typeof createMockDeps>;
  let dnsManager: DnsManager;

  beforeEach(() => {
    provider = new MockDnsProvider();
    deps = createMockDeps(provider);
    dnsManager = new DnsManager(deps, config);
  });

  describe('prepare', () => {
    it('should prepare DNS records and set status', async () => {
      const tenantId = asTenantId('tenant-1');
      const mappingId = asMappingId('mapping-1');

      const status = await dnsManager.prepare(tenantId, mappingId);

      expect(status.tenantId).toBe('tenant-1');
      expect(status.mappingId).toBe('mapping-1');
      expect(status.domain).toBe(domain);
      expect(status.phase).toBe('NOT_STARTED');
      expect(status.records.length).toBeGreaterThan(0);
      expect(status.startedAt).toBeDefined();
    });

    it('should log DNS_PREPARED event', async () => {
      const tenantId = asTenantId('tenant-1');
      const mappingId = asMappingId('mapping-1');

      await dnsManager.prepare(tenantId, mappingId);

      const events = deps.getEvents();
      const prepareEvent = events.find(e => e.event === 'DNS_PREPARED');
      
      expect(prepareEvent).toBeDefined();
      expect(prepareEvent?.details?.recordCount).toBeGreaterThan(0);
      expect(prepareEvent?.details?.domain).toBe(domain);
    });
  });

  describe('execute', () => {
    it('should update DNS records successfully', async () => {
      const tenantId = asTenantId('tenant-1');
      const mappingId = asMappingId('mapping-1');

      const result = await dnsManager.execute(tenantId, mappingId);

      expect(result.success).toBe(true);
      expect(result.recordsUpdated).toBeGreaterThan(0);
      expect(result.failedRecords.length).toBe(0);
      expect(result.warnings).toContain('DNS propagation may take time');
    });

    it('should handle DNS update failure', async () => {
      provider.setShouldFail(true);
      const tenantId = asTenantId('tenant-1');
      const mappingId = asMappingId('mapping-1');

      const result = await dnsManager.execute(tenantId, mappingId);

      expect(result.success).toBe(false);
      expect(result.failedRecords.length).toBeGreaterThan(0);
      expect(result.recordsUpdated).toBe(0);
    });

    it('should log DNS events', async () => {
      const tenantId = asTenantId('tenant-1');
      const mappingId = asMappingId('mapping-1');

      await dnsManager.execute(tenantId, mappingId);

      const events = deps.getEvents();
      const updateEvent = events.find(e => e.event === 'DNS_UPDATED');
      
      expect(updateEvent).toBeDefined();
      expect(updateEvent?.details?.recordCount).toBeGreaterThan(0);
    });
  });

  describe('verify', () => {
    it('should verify DNS propagation successfully', async () => {
      const tenantId = asTenantId('tenant-1');
      const mappingId = asMappingId('mapping-1');

      const result = await dnsManager.verify(tenantId, mappingId, 3, 100);

      expect(result.success).toBe(true);
      expect(result.recordsVerified).toBeGreaterThan(0);
      expect(result.failedRecords.length).toBe(0);
    });

    it('should retry verification with delays', async () => {
      provider.setVerifyDelay(2);
      const tenantId = asTenantId('tenant-1');
      const mappingId = asMappingId('mapping-1');

      const result = await dnsManager.verify(tenantId, mappingId, 5, 10);

      expect(result.success).toBe(true);
      expect(result.recordsVerified).toBeGreaterThan(0);
    });

    it('should fail verification after max attempts', async () => {
      provider.setVerifyDelay(10);
      const tenantId = asTenantId('tenant-1');
      const mappingId = asMappingId('mapping-1');

      const result = await dnsManager.verify(tenantId, mappingId, 3, 10);

      expect(result.success).toBe(false);
      expect(result.failedRecords.length).toBeGreaterThan(0);
      expect(result.warnings).toContain('DNS propagation verification failed after 3 attempts');
    });
  });

  describe('rollback', () => {
    it('should rollback DNS changes successfully', async () => {
      const tenantId = asTenantId('tenant-1');
      const mappingId = asMappingId('mapping-1');
      
      const previousRecords: DnsRecord[] = [
        { type: 'MX', name: '@', value: 'old.mail.com', ttl: 3600, priority: 10 },
      ];

      const result = await dnsManager.rollback(tenantId, mappingId, previousRecords);

      expect(result.success).toBe(true);
      expect(result.recordsUpdated).toBe(1);
      expect(result.failedRecords.length).toBe(0);
    });

    it('should handle rollback failure', async () => {
      provider.setShouldFail(true);
      const tenantId = asTenantId('tenant-1');
      const mappingId = asMappingId('mapping-1');
      
      const previousRecords: DnsRecord[] = [
        { type: 'MX', name: '@', value: 'old.mail.com', ttl: 3600, priority: 10 },
      ];

      const result = await dnsManager.rollback(tenantId, mappingId, previousRecords);

      expect(result.success).toBe(false);
      expect(result.failedRecords.length).toBeGreaterThan(0);
    });
  });

  describe('buildDnsRecords', () => {
    it('should build all DNS record types', async () => {
      const tenantId = asTenantId('tenant-1');
      const mappingId = asMappingId('mapping-1');

      await dnsManager.prepare(tenantId, mappingId);
      const status = await deps.getStatus(tenantId, mappingId);
      const records = (status as DnsMigrationStatus | undefined)?.records ?? [];

      // Check MX records
      const mxRecords = records.filter(r => r.type === 'MX');
      expect(mxRecords).toHaveLength(2);
      expect(mxRecords[0]?.priority).toBe(10);
      expect(mxRecords[1]?.priority).toBe(20);

      // Check SPF record
      const spfRecord = records.find(r => r.type === 'TXT' && r.name === '@' && r.value.includes('v=spf1'));
      expect(spfRecord).toBeDefined();

      // Check DKIM record
      const dkimRecord = records.find(r => r.type === 'TXT' && r.name.includes('_domainkey'));
      expect(dkimRecord).toBeDefined();

      // Check DMARC record
      const dmarcRecord = records.find(r => r.type === 'TXT' && r.name === '_dmarc');
      expect(dmarcRecord).toBeDefined();
      expect(dmarcRecord?.value).toContain('v=DMARC1');
      expect(dmarcRecord?.value).toContain('p=quarantine');

      // Check Autodiscover record
      const autodiscoverRecord = records.find(r => r.name === 'autodiscover');
      expect(autodiscoverRecord).toBeDefined();
      expect(autodiscoverRecord?.type).toBe('CNAME');
    });
  });
});
