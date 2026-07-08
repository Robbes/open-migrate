// Type declarations for mollie-api-node
declare module 'mollie-api-node' {
  export interface Payment {
    id: string;
    status: string;
    amount: { value: string; currency: string };
    description: string;
    redirectUrl: string;
    webhookUrl: string;
    createdAt: string;
    paidAt?: string;
    canceledAt?: string;
    failedAt?: string;
  }

  export interface Customer {
    id: string;
    name: string;
    email: string;
    createdAt: string;
  }

  export interface Mandate {
    id: string;
    status: string;
    method: string;
    createdAt: string;
    validFrom?: string;
    validUntil?: string;
  }

  export interface Method {
    id: string;
    description: string;
    image?: {
      size1x: string;
      size2x: string;
      svg: string;
    };
  }

  export interface MollieApi {
    payments: {
      create(params: unknown): Promise<Payment>;
      get(id: string): Promise<Payment>;
    };
    customers: {
      create(params: unknown): Promise<Customer>;
      get(id: string): Promise<Customer>;
    };
    mandates: {
      create(customerId: string, params: unknown): Promise<Mandate>;
      revoke(id: string): Promise<void>;
    };
    methods: {
      list(): Promise<Method[]>;
    };
  }

  export function createClient(params: { apiKey: string }): MollieApi;
  
  const mollie: {
    createClient: typeof createClient;
  };
  
  export default mollie;
}
