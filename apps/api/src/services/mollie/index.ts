/**
 * Mollie Payment Service
 * 
 * Integration with Mollie payment gateway for processing payments.
 * Handles payment creation, webhook processing, and customer management.
 */

import { createMollieClient, Mandate, Method, PaymentMethod, MandateMethod } from '@mollie/api-client';

export interface MolliePayment {
  id: string;
  status: 'open' | 'canceled' | 'paid' | 'failed';
  amount: {
    value: string;
    currency: string;
  };
  description: string;
  redirectUrl?: string;
  webhookUrl?: string;
  createdAt: string;
  paidAt?: string;
  canceledAt?: string;
  failedAt?: string;
}

export interface MollieCustomer {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface CreatePaymentParams {
  tenantId: string;
  amount: number; // Amount in cents
  description: string;
  redirectUrl: string;
  webhookUrl?: string;
  customerId?: string;
  method?: PaymentMethod;
}

export interface CreateCustomerParams {
  tenantId: string;
  name: string;
  email: string;
}

class MollieService {
  private client: ReturnType<typeof createMollieClient>;

  constructor(apiKey: string) {
    this.client = createMollieClient({ apiKey });
  }

  /**
   * Create a new Mollie customer for a tenant
   */
  async createCustomer(params: CreateCustomerParams): Promise<MollieCustomer> {
    const customer = await this.client.customers.create({
      name: params.name,
      email: params.email,
      metadata: {
        tenantId: params.tenantId,
      },
    });

    return {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      createdAt: customer.createdAt,
    };
  }

  /**
   * Create a payment for an invoice
   */
  async createPayment(params: CreatePaymentParams): Promise<MolliePayment> {
    const payment = await this.client.payments.create({
      amount: {
        value: (params.amount / 100).toFixed(2), // Convert cents to euros
        currency: 'EUR',
      },
      description: params.description,
      redirectUrl: params.redirectUrl,
      webhookUrl: params.webhookUrl || `${process.env.API_URL}/api/billing/webhooks/mollie`,
      customerId: params.customerId,
      method: params.method,
      metadata: {
        tenantId: params.tenantId,
      },
    });

    return {
      id: payment.id,
      status: payment.status as MolliePayment['status'],
      amount: {
        value: payment.amount.value,
        currency: payment.amount.currency,
      },
      description: payment.description,
      redirectUrl: payment.redirectUrl,
      webhookUrl: payment.webhookUrl,
      createdAt: payment.createdAt,
      paidAt: payment.paidAt,
      canceledAt: payment.canceledAt,
      failedAt: payment.failedAt,
    };
  }

  /**
   * Get payment details
   */
  async getPayment(paymentId: string): Promise<MolliePayment> {
    const payment = await this.client.payments.get(paymentId);

    return {
      id: payment.id,
      status: payment.status as MolliePayment['status'],
      amount: {
        value: payment.amount.value,
        currency: payment.amount.currency,
      },
      description: payment.description,
      redirectUrl: payment.redirectUrl,
      webhookUrl: payment.webhookUrl,
      createdAt: payment.createdAt,
      paidAt: payment.paidAt,
      canceledAt: payment.canceledAt,
      failedAt: payment.failedAt,
    };
  }

  /**
   * Cancel a payment
   */
  async cancelPayment(paymentId: string): Promise<void> {
    await this.client.payments.cancel(paymentId);
  }

  /**
   * Get customer details
   */
  async getCustomer(customerId: string): Promise<MollieCustomer> {
    const customer = await this.client.customers.get(customerId);

    return {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      createdAt: customer.createdAt,
    };
  }

  /**
   * Create a payment method (mandate) for recurring payments
   */
  async createMandate(params: {
    customerId: string;
    method: MandateMethod;
    consumerName?: string;
    consumerAccount?: string;
    consumerBic?: string;
    consumerEmail?: string;
    signatureDate?: string;
    mandateReference?: string;
    paypalBillingAgreementId?: string;
  }): Promise<Mandate> {
    const mandate = await this.client.customerMandates.create({
      customerId: params.customerId,
      method: params.method,
      consumerName: params.consumerName,
      consumerAccount: params.consumerAccount,
      consumerBic: params.consumerBic,
      consumerEmail: params.consumerEmail,
      signatureDate: params.signatureDate,
      mandateReference: params.mandateReference,
      paypalBillingAgreementId: params.paypalBillingAgreementId,
    });

    return mandate;
  }

  /**
   * Get available payment methods
   */
  async getMethods(): Promise<Method[]> {
    const methods = await this.client.methods.list();
    return methods;
  }

  /**
   * Process webhook event from Mollie
   */
  async processWebhook(paymentId: string): Promise<{
    status: string;
    paidAt?: string;
    failedAt?: string;
  }> {
    const payment = await this.getPayment(paymentId);

    return {
      status: payment.status,
      paidAt: payment.paidAt,
      failedAt: payment.failedAt,
    };
  }
}

// Singleton instance
let mollieService: MollieService | null = null;

export function getMollieService(): MollieService {
  if (!mollieService) {
    const apiKey = process.env.MOLLIE_API_KEY;
    
    if (!apiKey) {
      throw new Error('MOLLIE_API_KEY environment variable not set');
    }
    
    mollieService = new MollieService(apiKey);
  }
  
  return mollieService;
}

export { MollieService };
