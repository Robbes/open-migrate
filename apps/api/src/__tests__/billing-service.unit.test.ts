import { describe, it, expect } from 'vitest';
import type { UsageMetrics } from '../services/billing-service';
import { calculateCost } from '../services/billing-service';

describe('Billing Service', () => {
  describe('calculateCost', () => {
    it('calculates cost with base fee only', () => {
      const metrics: Partial<UsageMetrics> = {
        storageUsedGB: 0,
        egressGB: 0,
        computeHours: 0,
        syncCount: 0,
      };

      const cost = calculateCost(metrics);

      expect(cost.storage).toBe(0);
      expect(cost.egress).toBe(0);
      expect(cost.compute).toBe(0);
      expect(cost.subtotal).toBe(999); // Base fee in cents
      expect(cost.tax).toBe(210); // 21% of 999 = 209.79, rounded to 210
      expect(cost.total).toBe(1209); // subtotal + tax
    });

    it('calculates cost with storage', () => {
      const metrics: Partial<UsageMetrics> = {
        storageUsedGB: 50,
        egressGB: 0,
        computeHours: 0,
        syncCount: 0,
      };

      const cost = calculateCost(metrics);

      expect(cost.storage).toBe(500); // 50 GB * €0.10 = €5.00 = 500 cents
      expect(cost.subtotal).toBe(1499); // 999 + 500
    });

    it('calculates cost with egress', () => {
      const metrics: Partial<UsageMetrics> = {
        storageUsedGB: 0,
        egressGB: 100,
        computeHours: 0,
        syncCount: 0,
      };

      const cost = calculateCost(metrics);

      expect(cost.egress).toBe(2000); // 100 GB * €0.20 = €20.00 = 2000 cents
      expect(cost.subtotal).toBe(2999); // 999 + 2000
    });

    it('calculates cost with compute', () => {
      const metrics: Partial<UsageMetrics> = {
        storageUsedGB: 0,
        egressGB: 0,
        computeHours: 20,
        syncCount: 0,
      };

      const cost = calculateCost(metrics);

      expect(cost.compute).toBe(100); // 20 hours * €0.05 = €1.00 = 100 cents
      expect(cost.subtotal).toBe(1099); // 999 + 100
    });

    it('calculates full cost with all metrics', () => {
      const metrics: Partial<UsageMetrics> = {
        storageUsedGB: 50,
        egressGB: 100,
        computeHours: 20,
        syncCount: 10,
      };

      const cost = calculateCost(metrics);

      expect(cost.storage).toBe(500);
      expect(cost.egress).toBe(2000);
      expect(cost.compute).toBe(100);
      expect(cost.subtotal).toBe(3599); // 999 + 500 + 2000 + 100
      expect(cost.tax).toBe(756); // 21% of 3599 = 755.79, rounded to 756
      expect(cost.total).toBe(4355); // 3599 + 756
    });

    it('handles zero metrics', () => {
      const metrics: Partial<UsageMetrics> = {};

      const cost = calculateCost(metrics);

      expect(cost.storage).toBe(0);
      expect(cost.egress).toBe(0);
      expect(cost.compute).toBe(0);
      expect(cost.subtotal).toBe(999);
      expect(cost.tax).toBe(210); // 21% of 999 = 209.79, rounded to 210
      expect(cost.total).toBe(1209); // 999 + 210
    });
  });
});
