/**
 * Billing Service
 * 
 * API client for billing-related operations.
 */

import apiClient from './api.js';

export interface UsageMetrics {
  id: string;
  tenantId: string;
  period: string;
  storageUsedGB: number;
  egressGB: number;
  computeHours: number;
  syncCount: number;
  lastUpdated: string;
}

export interface CurrentCost {
  storage: number;
  egress: number;
  compute: number;
  subtotal: number;
  tax: number;
  total: number;
}

export interface UsageResponse {
  usage: UsageMetrics;
  currentCost: CurrentCost;
  period: string;
}

export interface Invoice {
  id: string;
  tenantId: string;
  period: string;
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
  subtotal: number;
  tax: number;
  total: number;
  currency: string;
  createdAt: string;
  dueDate: string;
  paidAt?: string;
}

export interface PaymentMethod {
  id: string;
  tenantId: string;
  type: 'card' | 'banktransfer' | 'other';
  last4?: string;
  brand?: string;
  expiryMonth?: number;
  expiryYear?: number;
  isDefault: boolean;
  createdAt: string;
}

export interface CostEstimate {
  baseFee: number;
  storage: number;
  egress: number;
  compute: number;
  tax: number;
  total: number;
}

export const billingApi = {
  // Get current usage
  getCurrentUsage: async (): Promise<UsageResponse> => {
    const response = await apiClient.get('/billing/usage');
    return response.data;
  },

  // Record usage (internal use)
  recordUsage: async (metrics: Partial<UsageMetrics>) => {
    const response = await apiClient.post('/billing/usage', metrics);
    return response.data;
  },

  // Get usage history
  getUsageHistory: async () => {
    const response = await apiClient.get('/billing/usage/history');
    return response.data;
  },

  // Estimate cost
  estimateCost: async (metrics: Partial<UsageMetrics>): Promise<{ estimate: CostEstimate }> => {
    const response = await apiClient.post('/billing/estimate', metrics);
    return response.data;
  },

  // List invoices
  listInvoices: async (): Promise<{ invoices: Invoice[] }> => {
    const response = await apiClient.get('/billing/invoices');
    return response.data;
  },

  // Get invoice details
  getInvoice: async (invoiceId: string): Promise<{ invoice: Invoice }> => {
    const response = await apiClient.get(`/billing/invoices/${invoiceId}`);
    return response.data;
  },

  // Create payment for invoice
  createPayment: async (invoiceId: string): Promise<{ paymentUrl: string; paymentId: string }> => {
    const response = await apiClient.post(`/billing/invoices/${invoiceId}/pay`);
    return response.data;
  },

  // List payment methods
  getPaymentMethods: async (): Promise<{ paymentMethods: PaymentMethod[] }> => {
    const response = await apiClient.get('/billing/payment-methods');
    return response.data;
  },

  // Add payment method
  addPaymentMethod: async (data: {
    type: 'card' | 'banktransfer' | 'other';
    last4?: string;
    brand?: string;
    expiryMonth?: number;
    expiryYear?: number;
  }): Promise<{ paymentMethod: PaymentMethod }> => {
    const response = await apiClient.post('/billing/payment-methods', data);
    return response.data;
  },

  // Set default payment method
  setDefaultPaymentMethod: async (paymentMethodId: string): Promise<{ paymentMethod: PaymentMethod }> => {
    const response = await apiClient.patch(`/billing/payment-methods/${paymentMethodId}/default`);
    return response.data;
  },
};
