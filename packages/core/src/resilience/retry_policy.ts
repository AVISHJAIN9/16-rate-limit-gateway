/**
 * F95 & F96: Exponential backoff reconnect & Upstream retries with full jitter and retry budget.
 */

export interface RetryOptions {
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  idempotentMethodsOnly?: boolean;
}

export class RetryBudget {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly costPerRetry: number;

  constructor(maxTokens = 100, costPerRetry = 10) {
    this.tokens = maxTokens;
    this.maxTokens = maxTokens;
    this.costPerRetry = costPerRetry;
  }

  recordSuccess(): void {
    if (this.tokens < this.maxTokens) {
      this.tokens += 1;
    }
  }

  canRetry(): boolean {
    if (this.tokens >= this.costPerRetry) {
      this.tokens -= this.costPerRetry;
      return true;
    }
    return false;
  }

  get availableTokens(): number {
    return this.tokens;
  }
}

export class RetryPolicy {
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly idempotentMethodsOnly: boolean;
  private readonly budget: RetryBudget;

  constructor(options: RetryOptions = {}, budget?: RetryBudget) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 50;
    this.maxBackoffMs = options.maxBackoffMs ?? 1000;
    this.idempotentMethodsOnly = options.idempotentMethodsOnly ?? true;
    this.budget = budget ?? new RetryBudget();
  }

  isRetryableMethod(method: string): boolean {
    if (!this.idempotentMethodsOnly) return true;
    const m = method.toUpperCase();
    return ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(m);
  }

  calculateBackoff(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      return Math.min(retryAfterMs, this.maxBackoffMs);
    }
    const cap = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** attempt);
    // Full jitter: uniformly distributed in [0, cap]
    return Math.floor(Math.random() * (cap + 1));
  }

  async execute<T>(
    operation: (attempt: number) => Promise<T>,
    method = 'GET',
    shouldRetry: (err: any) => boolean = () => true
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        const result = await operation(attempt);
        this.budget.recordSuccess();
        return result;
      } catch (err: any) {
        attempt++;
        if (attempt > this.maxRetries) {
          throw err;
        }
        if (!this.isRetryableMethod(method)) {
          throw err;
        }
        if (!shouldRetry(err)) {
          throw err;
        }
        if (!this.budget.canRetry()) {
          throw new Error('Retry budget exhausted: rejecting retry to prevent retry storm');
        }
        const delayMs = this.calculateBackoff(attempt);
        if (delayMs > 0) {
          await new Promise((res) => setTimeout(res, delayMs));
        }
      }
    }
  }
}
