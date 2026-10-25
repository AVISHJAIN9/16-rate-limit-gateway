/**
 * F95 & F96: Exponential backoff reconnect & Upstream retries with full jitter and retry budget.
 */
export class RetryBudget {
    tokens;
    maxTokens;
    costPerRetry;
    constructor(maxTokens = 100, costPerRetry = 10) {
        this.tokens = maxTokens;
        this.maxTokens = maxTokens;
        this.costPerRetry = costPerRetry;
    }
    recordSuccess() {
        if (this.tokens < this.maxTokens) {
            this.tokens += 1;
        }
    }
    canRetry() {
        if (this.tokens >= this.costPerRetry) {
            this.tokens -= this.costPerRetry;
            return true;
        }
        return false;
    }
    get availableTokens() {
        return this.tokens;
    }
}
export class RetryPolicy {
    maxRetries;
    baseBackoffMs;
    maxBackoffMs;
    idempotentMethodsOnly;
    budget;
    constructor(options = {}, budget) {
        this.maxRetries = options.maxRetries ?? 3;
        this.baseBackoffMs = options.baseBackoffMs ?? 50;
        this.maxBackoffMs = options.maxBackoffMs ?? 1000;
        this.idempotentMethodsOnly = options.idempotentMethodsOnly ?? true;
        this.budget = budget ?? new RetryBudget();
    }
    isRetryableMethod(method) {
        if (!this.idempotentMethodsOnly)
            return true;
        const m = method.toUpperCase();
        return ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(m);
    }
    calculateBackoff(attempt, retryAfterMs) {
        if (retryAfterMs !== undefined && retryAfterMs > 0) {
            return Math.min(retryAfterMs, this.maxBackoffMs);
        }
        const cap = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** attempt);
        // Full jitter: uniformly distributed in [0, cap]
        return Math.floor(Math.random() * (cap + 1));
    }
    async execute(operation, method = 'GET', shouldRetry = () => true) {
        let attempt = 0;
        while (true) {
            try {
                const result = await operation(attempt);
                this.budget.recordSuccess();
                return result;
            }
            catch (err) {
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
