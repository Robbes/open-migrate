/**
 * Throttling and Rate Limiting Module
 * 
 * Provides:
 * - Token bucket rate limiter per (tenant, provider)
 * - Global concurrency cap
 * - Honor Retry-After header on 429/503 responses
 * - Throttle event counting in run stats
 * - Exponential backoff with jitter for other errors
 * - Budgets configurable via mapping config
 */

import { mapWithConcurrency } from './concurrency';

/**
 * Throttle budget configuration
 */
export interface ThrottleConfig {
  /** Max concurrent requests (default: 4) */
  maxConcurrent: number;
  
  /** Rate limit in requests per second (default: 10) */
  requestsPerSecond: number;
  
  /** Max retry attempts (default: 5) */
  maxRetries: number;
  
  /** Base backoff in milliseconds (default: 1000) */
  baseBackoffMs: number;
  
  /** Max backoff in milliseconds (default: 60000) */
  maxBackoffMs: number;
  
  /** Jitter range in milliseconds (default: 500) */
  jitterMs: number;
}

/**
 * Default throttle configuration
 */
export const DEFAULT_THROTTLE_CONFIG: ThrottleConfig = {
  maxConcurrent: 4,
  requestsPerSecond: 10,
  maxRetries: 5,
  baseBackoffMs: 1000,
  maxBackoffMs: 60000,
  jitterMs: 500,
};

/**
 * Throttle event statistics
 */
export interface ThrottleStats {
  /** Total number of throttle events (429/503 responses) */
  throttleEvents: number;
  
  /** Total number of retries attempted */
  retryAttempts: number;
  
  /** Total time spent waiting due to throttling (ms) */
  totalWaitTimeMs: number;
  
  /** Number of requests that exceeded max retries */
  exceededMaxRetries: number;
}

/**
 * Token bucket implementation for rate limiting
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per second

  constructor(capacity: number, refillRate: number) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /**
   * Try to consume a token, returns true if successful
   */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      return true;
    }
    return false;
  }

  /**
   * Wait until a token is available, then consume it
   */
  async acquire(): Promise<void> {
    while (!this.tryConsume()) {
      const waitTime = this.getTimeUntilToken();
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  /**
   * Get time in ms until a token is available
   */
  private getTimeUntilToken(): number {
    const tokensNeeded = 1 - this.tokens;
    const secondsNeeded = tokensNeeded / this.refillRate;
    return Math.ceil(secondsNeeded * 1000);
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsedSeconds * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}

/**
 * Throttle limiter that manages rate limiting and concurrency for API requests
 */
export class ThrottleLimiter {
  private readonly buckets: Map<string, TokenBucket>;
  private readonly _config: ThrottleConfig;
  private readonly stats: ThrottleStats;
  private activeRequests: number;
  private readonly retryDelays: Map<string, number>; // Track retry delays per key

  constructor(config: Partial<ThrottleConfig> = {}) {
    this._config = { ...DEFAULT_THROTTLE_CONFIG, ...config };
    this.buckets = new Map();
    this.stats = {
      throttleEvents: 0,
      retryAttempts: 0,
      totalWaitTimeMs: 0,
      exceededMaxRetries: 0,
    };
    this.activeRequests = 0;
    this.retryDelays = new Map();
  }

  /**
   * Get the throttle configuration (read-only)
   */
  get config(): Readonly<ThrottleConfig> {
    return { ...this._config };
  }

  /**
   * Get or create a token bucket for a (tenant, provider) pair
   */
  private getBucket(tenantId: string, provider: string): TokenBucket {
    const key = `${tenantId}:${provider}`;
    if (!this.buckets.has(key)) {
      this.buckets.set(key, new TokenBucket(
        this._config.requestsPerSecond,
        this._config.requestsPerSecond
      ));
    }
    return this.buckets.get(key)!;
  }

  /**
   * Wait for rate limit and concurrency slot
   */
  async waitForSlot(tenantId: string, provider: string): Promise<void> {
    // Wait for concurrency slot
    while (this.activeRequests >= this.config.maxConcurrent) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.activeRequests++;

    try {
      // Wait for rate limit token
      const bucket = this.getBucket(tenantId, provider);
      await bucket.acquire();
    } catch (error) {
      this.activeRequests--;
      throw error;
    }
  }

  /**
   * Release a concurrency slot
   */
  releaseSlot(): void {
    this.activeRequests--;
  }

  /**
   * Calculate backoff delay with jitter
   * Formula: min(base * (2^attempt) + random(jitter), max)
   */
  calculateBackoff(attempt: number): number {
    const exponentialBackoff = this.config.baseBackoffMs * Math.pow(2, attempt);
    const jitter = Math.random() * this.config.jitterMs;
    const totalDelay = exponentialBackoff + jitter;
    return Math.min(totalDelay, this.config.maxBackoffMs);
  }

  /**
   * Parse Retry-After header value
   * Supports both seconds (integer) and HTTP-date format
   */
  parseRetryAfterHeader(headerValue: string): number {
    // Try to parse as seconds (integer)
    const seconds = parseInt(headerValue, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }

    // Try to parse as HTTP-date
    try {
      const date = new Date(headerValue);
      if (!isNaN(date.getTime())) {
        const now = Date.now();
        const retryAt = date.getTime();
        return Math.max(0, retryAt - now);
      }
    } catch {
      // Ignore parsing errors
    }

    // Default to 60 seconds if parsing fails
    return 60000;
  }

  /**
   * Handle a 429 or 503 response
   * Returns the wait time in ms
   */
  handleRateLimited(responseStatus: number, retryAfterHeader?: string): number {
    this.stats.throttleEvents++;
    
    let waitTime = 0;
    
    if (retryAfterHeader) {
      waitTime = this.parseRetryAfterHeader(retryAfterHeader);
    } else {
      // Default backoff if no Retry-After header
      waitTime = this.calculateBackoff(0);
    }

    return waitTime;
  }

  /**
   * Execute a request with throttling, retry logic, and backoff
   * 
   * @param tenantId - The tenant ID
   * @param provider - The provider name (e.g., 'graph.microsoft.com')
   * @param requestFn - Async function that returns { status, headers, body }
   * @returns The response from the request
   */
  async executeWithThrottling<T>(
    tenantId: string,
    provider: string,
    requestFn: () => Promise<{ status: number; headers: Record<string, string>; body: string }>,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    let lastError: Error | undefined;
    let attempt = 0;

    while (attempt <= this.config.maxRetries) {
      try {
        // Wait for rate limit and concurrency slot
        await this.waitForSlot(tenantId, provider);

        // Execute the request
        const response = await requestFn();

        // Check for rate limited response
        if (response.status === 429 || response.status === 503) {
          this.stats.retryAttempts++;
          const retryAfter = response.headers['retry-after'];
          const waitTime = this.handleRateLimited(response.status, retryAfter);
          
          this.stats.totalWaitTimeMs += waitTime;
          
          if (attempt < this.config.maxRetries) {
            await new Promise(resolve => setTimeout(resolve, waitTime));
            attempt++;
            continue;
          } else {
            this.stats.exceededMaxRetries++;
            throw new Error(`Rate limited after ${this.config.maxRetries} retries. Status: ${response.status}`);
          }
        }

        // Success
        this.releaseSlot();
        return response;

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Don't retry on non-transient errors
        if (error instanceof Error && !this.isTransientError(error)) {
          this.releaseSlot();
          throw error;
        }

        attempt++;
        
        if (attempt > this.config.maxRetries) {
          this.stats.exceededMaxRetries++;
          this.releaseSlot();
          throw lastError;
        }

        // Calculate backoff with jitter
        const backoff = this.calculateBackoff(attempt - 1);
        this.stats.totalWaitTimeMs += backoff;
        this.stats.retryAttempts++;
        
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }

    // Should never reach here, but TypeScript needs a return
    this.releaseSlot();
    throw lastError;
  }

  /**
   * Check if an error is transient (retryable)
   */
  private isTransientError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('connection') ||
      message.includes('ECONN') ||
      message.includes('ETIMEDOUT') ||
      message.includes('EPIPE')
    );
  }

  /**
   * Get current throttle statistics
   */
  getStats(): Readonly<ThrottleStats> {
    return { ...this.stats };
  }

  /**
   * Reset throttle statistics
   */
  resetStats(): void {
    this.stats.throttleEvents = 0;
    this.stats.retryAttempts = 0;
    this.stats.totalWaitTimeMs = 0;
    this.stats.exceededMaxRetries = 0;
  }

  /**
   * Get the number of active requests
   */
  getActiveRequests(): number {
    return this.activeRequests;
  }
}

/**
 * Throttle configuration mapping per domain/provider
 */
export interface ThrottleConfigMapping {
  [domain: string]: Partial<ThrottleConfig>;
}

/**
 * Create a ThrottleLimiter from a configuration mapping
 * Allows per-domain configuration with fallback to defaults
 */
export function createThrottleLimiterFromMapping(
  mapping: ThrottleConfigMapping,
  defaultConfig: Partial<ThrottleConfig> = {}
): ThrottleLimiter {
  // Merge all configs, using the first non-empty config as the base
  // For now, we use a single limiter with the merged config
  // In the future, this could create per-domain limiters
  
  const mergedConfig: ThrottleConfig = { ...DEFAULT_THROTTLE_CONFIG, ...defaultConfig };
  
  // Apply the most restrictive settings from all domains
  for (const domainConfig of Object.values(mapping)) {
    if (domainConfig.maxConcurrent && domainConfig.maxConcurrent < mergedConfig.maxConcurrent) {
      mergedConfig.maxConcurrent = domainConfig.maxConcurrent;
    }
    if (domainConfig.requestsPerSecond && domainConfig.requestsPerSecond < mergedConfig.requestsPerSecond) {
      mergedConfig.requestsPerSecond = domainConfig.requestsPerSecond;
    }
  }

  return new ThrottleLimiter(mergedConfig);
}

/**
 * Execute multiple requests with throttling and concurrency control
 */
export async function executeWithConcurrencyAndThrottling<T, R>(
  items: ReadonlyArray<T>,
  throttleLimiter: ThrottleLimiter,
  tenantId: string,
  provider: string,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const errors: Error[] = [];

  await mapWithConcurrency(
    items,
    throttleLimiter.config.maxConcurrent,
    async (item: T, index: number) => {
      try {
        const result = await worker(item, index);
        results.push(result);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  if (errors.length > 0) {
    throw errors[0];
  }

  return results;
}
