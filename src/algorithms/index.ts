import type { Clock } from '../time/clock.js';
import { runStoreContract } from '../store/contract.js';

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  resetMs: number;
}

export interface Decision extends RateDecision {
  policyId: string;
  ruleId: string;
  scope: string;
  reason: string;
  limit: number;
}

export interface RefillCalculationInput {
  capacity: number;
  refillPerMs: number;
  available: number;
  elapsedMs: number;
}

export function monotonicElapsedMs(startNs: bigint, endNs: bigint): number {
  if (endNs <= startNs) {
    return 0;
  }

  const diffNs = endNs - startNs;
  const ms = diffNs / 1_000_000n;

  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number.MAX_SAFE_INTEGER;
  }

  return Number(ms);
}

export function calculateRefill({ capacity, refillPerMs, available, elapsedMs }: RefillCalculationInput): number {
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error('capacity must be a positive number');
  }

  if (!Number.isFinite(available) || available < 0) {
    throw new Error('available must be non-negative');
  }

  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error('elapsedMs must be a non-negative number');
  }

  const finalAvailable = available + elapsedMs * Math.max(0, refillPerMs);
  return Math.min(capacity, Math.max(0, finalAvailable));
}

interface TokenBucketOptions {
  capacity: number;
  refillPerMs: number;
  initialTokens?: number;
  clock?: Clock;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly clock?: Clock;
  private available: number;
  private lastSeenMs: number;

  constructor({ capacity, refillPerMs, initialTokens = capacity, clock }: TokenBucketOptions) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error('capacity must be > 0');
    }

    if (!Number.isFinite(refillPerMs) || refillPerMs < 0) {
      throw new Error('refillPerMs must be >= 0');
    }

    if (!Number.isFinite(initialTokens) || initialTokens < 0 || initialTokens > capacity) {
      throw new Error('initialTokens must be between 0 and capacity');
    }

    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
    this.clock = clock;
    this.available = initialTokens;
    this.lastSeenMs = 0;
  }

  check({ cost, nowMs }: { cost: number; nowMs: number }): RateDecision {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new Error('cost must be > 0');
    }

    const effectiveNowMs = nowMs;
    const elapsedMs = Math.max(0, effectiveNowMs - this.lastSeenMs);
    this.available = calculateRefill({
      capacity: this.capacity,
      refillPerMs: this.refillPerMs,
      available: this.available,
      elapsedMs
    });
    this.lastSeenMs = effectiveNowMs;

    if (cost <= this.available) {
      this.available -= cost;
      return {
        allowed: true,
        remaining: Math.max(0, this.available),
        retryAfterMs: 0,
        resetMs: effectiveNowMs
      };
    }

    const deficit = cost - this.available;
    const retryAfterMs = this.refillPerMs > 0 ? Math.ceil(deficit / this.refillPerMs) : Number.POSITIVE_INFINITY;

    return {
      allowed: false,
      remaining: 0,
      retryAfterMs,
      resetMs: effectiveNowMs + retryAfterMs
    };
  }
}

interface LeakyBucketOptions {
  capacity: number;
  leakPerMs: number;
  initialLevel?: number;
}

export class LeakyBucket {
  private readonly capacity: number;
  private readonly leakPerMs: number;
  private level: number;
  private lastSeenMs: number;

  constructor({ capacity, leakPerMs, initialLevel = capacity }: LeakyBucketOptions) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error('capacity must be > 0');
    }

    if (!Number.isFinite(leakPerMs) || leakPerMs <= 0) {
      throw new Error('leakPerMs must be > 0');
    }

    if (!Number.isFinite(initialLevel) || initialLevel < 0 || initialLevel > capacity) {
      throw new Error('initialLevel must be between 0 and capacity');
    }

    this.capacity = capacity;
    this.leakPerMs = leakPerMs;
    this.level = initialLevel;
    this.lastSeenMs = 0;
  }

  check({ cost, nowMs }: { cost: number; nowMs: number }): RateDecision {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new Error('cost must be > 0');
    }

    const elapsedMs = Math.max(0, nowMs - this.lastSeenMs);
    this.level = Math.max(0, this.level - elapsedMs * this.leakPerMs);
    this.lastSeenMs = nowMs;

    if (this.level + cost <= this.capacity) {
      this.level += cost;
      return {
        allowed: true,
        remaining: Math.max(0, this.capacity - this.level),
        retryAfterMs: 0,
        resetMs: nowMs
      };
    }

    const excess = this.level + cost - this.capacity;
    const retryAfterMs = Math.ceil(excess / this.leakPerMs);

    return {
      allowed: false,
      remaining: Math.max(0, this.capacity - this.level),
      retryAfterMs,
      resetMs: nowMs + retryAfterMs
    };
  }
}

interface GCRAOptions {
  capacity: number;
  ratePerSecond: number;
  initialTAT?: number;
}

export class GCRA {
  private readonly capacity: number;
  private readonly intervalMs: number;
  private readonly toleranceMs: number;
  private tat: number;

  constructor({ capacity, ratePerSecond, initialTAT = 0 }: GCRAOptions) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error('capacity must be > 0');
    }

    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) {
      throw new Error('ratePerSecond must be > 0');
    }

    this.capacity = capacity;
    this.intervalMs = 1000 / ratePerSecond;
    this.toleranceMs = (capacity - 1) * this.intervalMs;
    this.tat = initialTAT;
  }

  check({ cost, nowMs }: { cost: number; nowMs: number }): RateDecision {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new Error('cost must be > 0');
    }

    const interval = this.intervalMs * cost;
    const earliestEligible = this.tat - this.toleranceMs;

    if (nowMs >= earliestEligible) {
      const nextTat = Math.max(this.tat, nowMs) + interval;
      this.tat = nextTat;
      return {
        allowed: true,
        remaining: this.capacity - cost,
        retryAfterMs: 0,
        resetMs: nextTat
      };
    }

    const retryAfterMs = Math.ceil(earliestEligible - nowMs);

    return {
      allowed: false,
      remaining: 0,
      retryAfterMs,
      resetMs: nowMs + retryAfterMs
    };
  }
}

export interface FixedWindowCounterOptions {
  windowMs: number;
  limit: number;
  clock?: Clock;
}

export class FixedWindowCounter {
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly clock?: Clock;
  private readonly buckets = new Map<number, number>();

  constructor({ windowMs, limit, clock }: FixedWindowCounterOptions) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error('windowMs must be > 0');
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error('limit must be > 0');
    }

    this.windowMs = windowMs;
    this.limit = limit;
    this.clock = clock;
  }

  check({ cost, nowMs }: { cost: number; nowMs: number }): Decision {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new Error('cost must be > 0');
    }

    const effectiveNowMs = nowMs;
    const bucketStart = Math.floor(effectiveNowMs / this.windowMs) * this.windowMs;
    const current = this.buckets.get(bucketStart) ?? 0;
    const next = current + cost;
    const allowed = next <= this.limit;

    if (allowed) {
      this.buckets.set(bucketStart, next);
    }

    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - next),
      retryAfterMs: allowed ? 0 : this.windowMs,
      resetMs: bucketStart + this.windowMs,
      policyId: 'fixed-window',
      ruleId: 'fixed-window',
      scope: 'window',
      reason: allowed ? 'within-limit' : 'limit-exceeded'
    };
  }
}

export interface SlidingWindowCounterOptions {
  limit: number;
  windowMs: number;
  clock?: Clock;
}

export class SlidingWindowCounter {
  requests: Array<{ timestampMs: number; cost: number }> = [];
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly clock?: Clock;

  constructor({ limit, windowMs, clock }: SlidingWindowCounterOptions) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
  }

  check({ cost, nowMs }: { cost: number; nowMs: number }): Decision {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new Error('cost must be > 0');
    }

    const effectiveNowMs = nowMs;
    const cutoff = effectiveNowMs - this.windowMs;
    const activeRequests = this.requests.filter((entry) => entry.timestampMs > cutoff);
    const current = activeRequests.reduce((sum, entry) => sum + entry.cost, 0);
    const next = current + cost;
    const allowed = next <= this.limit;

    const nextRequests = [...activeRequests];
    if (allowed) {
      nextRequests.push({ timestampMs: effectiveNowMs, cost });
    }
    this.requests = nextRequests;

    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - next),
      retryAfterMs: allowed ? 0 : this.windowMs,
      resetMs: effectiveNowMs + this.windowMs,
      policyId: 'sliding-window',
      ruleId: 'sliding-window',
      scope: 'window',
      reason: allowed ? 'within-limit' : 'limit-exceeded'
    };
  }
}

export interface SlidingWindowApproximationCounterOptions extends SlidingWindowCounterOptions {
  weight?: number;
}

export class SlidingWindowApproximationCounter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly weight: number;
  private readonly clock?: Clock;
  private readonly recent: number[] = [];

  constructor({ limit, windowMs, clock, weight = 0.5 }: SlidingWindowApproximationCounterOptions) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.weight = weight;
  }

  check({ cost, nowMs }: { cost: number; nowMs: number }): Decision {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new Error('cost must be > 0');
    }

    const effectiveNowMs = nowMs;
    const cutoff = effectiveNowMs - this.windowMs;
    while (this.recent.length > 0 && this.recent[0] <= cutoff) {
      this.recent.shift();
    }
    const current = this.recent.length;
    const weighted = current * this.weight + (this.recent.length > 0 ? this.recent[this.recent.length - 1] * (1 - this.weight) : 0);
    const next = weighted + cost;
    const allowed = next <= this.limit;

    if (allowed) {
      this.recent.push(effectiveNowMs);
    }

    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - next),
      retryAfterMs: allowed ? 0 : this.windowMs,
      resetMs: effectiveNowMs + this.windowMs,
      policyId: 'sliding-window-approx',
      ruleId: 'sliding-window-approx',
      scope: 'window',
      reason: allowed ? 'within-limit' : 'limit-exceeded'
    };
  }
}

export class WeightedRequestCost {
  static apply(baseCost: number, multiplier: number): number {
    if (!Number.isFinite(baseCost) || baseCost < 0) {
      throw new Error('baseCost must be a non-negative finite number');
    }

    if (!Number.isFinite(multiplier) || multiplier < 0) {
      throw new Error('multiplier must be a non-negative finite number');
    }

    if (multiplier === 0) {
      return 0;
    }

    const weighted = baseCost * multiplier;
    return Math.min(baseCost, Math.max(0, Math.ceil(weighted)));
  }
}

export function calculateSlidingWindow({
  limit,
  windowMs,
  requests,
  nowMs,
  cost
}: {
  limit: number;
  windowMs: number;
  requests: Array<{ timestampMs: number; cost: number }>;
  nowMs: number;
  cost: number;
}): Decision {
  const cutoff = nowMs - windowMs;
  const active = requests.filter((entry) => entry.timestampMs > cutoff && entry.timestampMs <= nowMs);
  const next = active.reduce((sum, entry) => sum + entry.cost, 0) + cost;
  const allowed = next <= limit;

  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - next),
    retryAfterMs: allowed ? 0 : windowMs,
    resetMs: nowMs + windowMs,
    policyId: 'sliding-window',
    ruleId: 'sliding-window',
    scope: 'window',
    reason: allowed ? 'within-limit' : 'limit-exceeded'
  };
}

export interface ClockSkewGuardOptions {
  maxSkewMs: number;
  clock?: Clock;
}

export class ClockSkewGuard {
  private readonly maxSkewMs: number;
  private readonly clock?: Clock;
  private skewEvents = 0;

  constructor({ maxSkewMs, clock }: ClockSkewGuardOptions) {
    this.maxSkewMs = maxSkewMs;
    this.clock = clock;
  }

  observe(observedMs: number): { skewMs: number; capped: boolean; skewEvent: boolean } {
    const nowMs = this.clock ? this.clock.nowMs() : observedMs;
    const skewMs = Math.max(0, nowMs - observedMs);
    const capped = skewMs > this.maxSkewMs;

    if (capped) {
      this.skewEvents += 1;
    }

    return {
      skewMs: Math.min(this.maxSkewMs, skewMs),
      capped,
      skewEvent: capped
    };
  }

  getSkewEvents(): number {
    return this.skewEvents;
  }
}

export { runStoreContract };
