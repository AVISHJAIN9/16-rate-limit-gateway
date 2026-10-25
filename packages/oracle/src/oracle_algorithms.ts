import type {
  TokenBucketParams,
  LeakyBucketParams,
  FixedWindowParams,
  SlidingWindowLogParams,
  SlidingWindowCounterParams,
  GCRAParams,
  Decision
} from '@rlgw/core';

export class OracleTokenBucket {
  private tokens: number;
  private lastMs: number;

  constructor(private readonly params: TokenBucketParams, initialMs = 0) {
    this.tokens = params.capacity;
    this.lastMs = initialMs;
  }

  step(cost: number, nowMs: number, peek = false): Decision {
    const elapsedMs = Math.max(0, nowMs - this.lastMs);
    const refilled = elapsedMs * (this.params.refillRate / 1000);
    this.tokens = Math.min(this.params.capacity, this.tokens + refilled);
    this.lastMs = nowMs;

    if (cost > this.params.capacity) {
      return {
        allowed: false,
        limit: this.params.capacity,
        remaining: this.tokens,
        resetMs: nowMs,
        retryAfterMs: Number.POSITIVE_INFINITY,
        policyId: 'token_bucket',
        reason: 'cost_exceeds_burst',
        cost,
        burst: this.params.capacity
      };
    }

    if (this.tokens >= cost) {
      if (!peek) {
        this.tokens -= cost;
      }
      return {
        allowed: true,
        limit: this.params.capacity,
        remaining: Math.max(0, this.tokens),
        resetMs: nowMs,
        retryAfterMs: 0,
        policyId: 'token_bucket',
        reason: 'ok',
        cost,
        burst: this.params.capacity
      };
    }

    const deficit = cost - this.tokens;
    const retryAfterMs = Math.ceil((deficit / this.params.refillRate) * 1000);
    return {
      allowed: false,
      limit: this.params.capacity,
      remaining: Math.max(0, this.tokens),
      resetMs: nowMs + retryAfterMs,
      retryAfterMs,
      policyId: 'token_bucket',
      reason: 'limit_exceeded',
      cost,
      burst: this.params.capacity
    };
  }

  refund(cost: number): void {
    this.tokens = Math.min(this.params.capacity, this.tokens + cost);
  }
}

export class OracleLeakyBucket {
  private level: number = 0;
  private lastMs: number;

  constructor(private readonly params: LeakyBucketParams, initialMs = 0) {
    this.lastMs = initialMs;
  }

  step(cost: number, nowMs: number, peek = false): Decision {
    const elapsedMs = Math.max(0, nowMs - this.lastMs);
    const leaked = elapsedMs * (this.params.leakRate / 1000);
    this.level = Math.max(0, this.level - leaked);
    this.lastMs = nowMs;

    if (cost > this.params.capacity) {
      return {
        allowed: false,
        limit: this.params.capacity,
        remaining: Math.max(0, this.params.capacity - this.level),
        resetMs: nowMs,
        retryAfterMs: Number.POSITIVE_INFINITY,
        policyId: 'leaky_bucket',
        reason: 'cost_exceeds_burst',
        cost,
        burst: this.params.capacity
      };
    }

    if (this.level + cost <= this.params.capacity) {
      if (!peek) {
        this.level += cost;
      }
      return {
        allowed: true,
        limit: this.params.capacity,
        remaining: Math.max(0, this.params.capacity - this.level),
        resetMs: nowMs + Math.ceil((this.level / this.params.leakRate) * 1000),
        retryAfterMs: 0,
        policyId: 'leaky_bucket',
        reason: 'ok',
        cost,
        burst: this.params.capacity
      };
    }

    const excess = (this.level + cost) - this.params.capacity;
    const retryAfterMs = Math.ceil((excess / this.params.leakRate) * 1000);
    return {
      allowed: false,
      limit: this.params.capacity,
      remaining: Math.max(0, this.params.capacity - this.level),
      resetMs: nowMs + retryAfterMs,
      retryAfterMs,
      policyId: 'leaky_bucket',
      reason: this.params.variant === 'shaping' ? 'delayed' : 'limit_exceeded',
      cost,
      burst: this.params.capacity
    };
  }

  refund(cost: number): void {
    this.level = Math.max(0, this.level - cost);
  }
}

export class OracleFixedWindow {
  private count = 0;
  private currentWindowStart = 0;

  constructor(private readonly params: FixedWindowParams) {}

  step(cost: number, nowMs: number, peek = false): Decision {
    const windowStart = Math.floor(nowMs / this.params.windowMs) * this.params.windowMs;
    const resetMs = windowStart + this.params.windowMs;

    if (this.currentWindowStart !== windowStart) {
      this.count = 0;
      this.currentWindowStart = windowStart;
    }

    if (this.count + cost <= this.params.limit) {
      if (!peek) {
        this.count += cost;
      }
      return {
        allowed: true,
        limit: this.params.limit,
        remaining: Math.max(0, this.params.limit - this.count),
        resetMs,
        retryAfterMs: 0,
        policyId: 'fixed_window',
        reason: 'ok',
        cost
      };
    }

    return {
      allowed: false,
      limit: this.params.limit,
      remaining: Math.max(0, this.params.limit - this.count),
      resetMs,
      retryAfterMs: Math.max(0, resetMs - nowMs),
      policyId: 'fixed_window',
      reason: 'limit_exceeded',
      cost
    };
  }

  refund(cost: number): void {
    this.count = Math.max(0, this.count - cost);
  }
}

export class OracleSlidingWindowLog {
  private entries: Array<{ ts: number; cost: number }> = [];

  constructor(private readonly params: SlidingWindowLogParams) {}

  step(cost: number, nowMs: number, peek = false): Decision {
    const cutoff = nowMs - this.params.windowMs;
    this.entries = this.entries.filter((e) => e.ts > cutoff && e.ts <= nowMs);

    const sum = this.entries.reduce((acc, e) => acc + e.cost, 0);

    if (sum + cost <= this.params.limit) {
      if (!peek) {
        this.entries.push({ ts: nowMs, cost });
      }
      return {
        allowed: true,
        limit: this.params.limit,
        remaining: Math.max(0, this.params.limit - (sum + (peek ? 0 : cost))),
        resetMs: this.entries.length > 0 ? this.entries[0].ts + this.params.windowMs : nowMs + this.params.windowMs,
        retryAfterMs: 0,
        policyId: 'sliding_window_log',
        reason: 'ok',
        cost
      };
    }

    let needed = (sum + cost) - this.params.limit;
    let retryAfterMs = this.params.windowMs;
    for (const entry of this.entries) {
      needed -= entry.cost;
      if (needed <= 0) {
        retryAfterMs = Math.max(0, (entry.ts + this.params.windowMs) - nowMs);
        break;
      }
    }

    return {
      allowed: false,
      limit: this.params.limit,
      remaining: Math.max(0, this.params.limit - sum),
      resetMs: nowMs + retryAfterMs,
      retryAfterMs,
      policyId: 'sliding_window_log',
      reason: 'limit_exceeded',
      cost
    };
  }

  refund(cost: number): void {
    let rem = cost;
    for (let i = this.entries.length - 1; i >= 0 && rem > 0; i--) {
      if (this.entries[i].cost <= rem) {
        rem -= this.entries[i].cost;
        this.entries.splice(i, 1);
      } else {
        this.entries[i].cost -= rem;
        rem = 0;
      }
    }
  }
}

export class OracleSlidingWindowCounter {
  private prevCount = 0;
  private currCount = 0;
  private currWindowStart = 0;

  constructor(private readonly params: SlidingWindowCounterParams) {}

  step(cost: number, nowMs: number, peek = false): Decision {
    const windowStart = Math.floor(nowMs / this.params.windowMs) * this.params.windowMs;

    if (this.currWindowStart === windowStart) {
      // same window
    } else if (this.currWindowStart === windowStart - this.params.windowMs) {
      this.prevCount = this.currCount;
      this.currCount = 0;
      this.currWindowStart = windowStart;
    } else {
      this.prevCount = 0;
      this.currCount = 0;
      this.currWindowStart = windowStart;
    }

    const weight = Math.min(1, Math.max(0, (nowMs - windowStart) / this.params.windowMs));
    const estimated = this.prevCount * (1 - weight) + this.currCount;
    const resetMs = windowStart + this.params.windowMs;

    if (estimated + cost <= this.params.limit) {
      if (!peek) {
        this.currCount += cost;
      }
      return {
        allowed: true,
        limit: this.params.limit,
        remaining: Math.max(0, Math.floor(this.params.limit - (estimated + (peek ? 0 : cost)))),
        resetMs,
        retryAfterMs: 0,
        policyId: 'sliding_window_counter',
        reason: 'ok',
        cost
      };
    }

    return {
      allowed: false,
      limit: this.params.limit,
      remaining: Math.max(0, Math.floor(this.params.limit - estimated)),
      resetMs,
      retryAfterMs: Math.max(0, resetMs - nowMs),
      policyId: 'sliding_window_counter',
      reason: 'limit_exceeded',
      cost
    };
  }

  refund(cost: number): void {
    this.currCount = Math.max(0, this.currCount - cost);
  }
}

export class OracleGCRA {
  private tatMs = 0;

  constructor(private readonly params: GCRAParams) {}

  step(cost: number, nowMs: number, peek = false): Decision {
    const intervalMs = 1000 / this.params.ratePerSecond;
    const burstToleranceMs = (this.params.capacity - 1) * intervalMs;

    const currentTat = this.tatMs <= 0 ? nowMs : this.tatMs;
    const earliestEligibleMs = currentTat - burstToleranceMs;

    if (nowMs >= earliestEligibleMs) {
      const nextTatMs = Math.max(nowMs, currentTat) + (peek ? 0 : intervalMs * cost);
      const remainingMs = Math.max(0, nextTatMs - nowMs);
      const remainingCells = Math.max(0, Math.floor((burstToleranceMs - remainingMs) / intervalMs));

      if (!peek) {
        this.tatMs = nextTatMs;
      }

      return {
        allowed: true,
        limit: this.params.capacity,
        remaining: remainingCells,
        resetMs: nextTatMs,
        retryAfterMs: 0,
        policyId: 'gcra',
        reason: 'ok',
        cost,
        burst: this.params.capacity
      };
    }

    const retryAfterMs = Math.max(0, Math.ceil(earliestEligibleMs - nowMs));
    return {
      allowed: false,
      limit: this.params.capacity,
      remaining: 0,
      resetMs: nowMs + retryAfterMs,
      retryAfterMs,
      policyId: 'gcra',
      reason: 'limit_exceeded',
      cost,
      burst: this.params.capacity
    };
  }

  refund(cost: number): void {
    const intervalMs = 1000 / this.params.ratePerSecond;
    this.tatMs = Math.max(0, this.tatMs - intervalMs * cost);
  }
}
