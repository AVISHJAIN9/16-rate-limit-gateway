import { TopKSketch } from './top_k.js';
import type { Decision } from '@rlgw/core';

export interface LocalTokenLease {
  tokensRemaining: number;
  leaseExpiresAtMs: number;
  limit: number;
  resetMs: number;
}

export class HotKeyShield {
  private sketch: TopKSketch;
  private leases = new Map<string, LocalTokenLease>();
  public readonly hotThreshold: number;
  public readonly maxLeaseBatch: number;
  public readonly leaseTTLMs: number;

  constructor(options: {
    sketchCapacity?: number;
    hotThreshold?: number;
    maxLeaseBatch?: number;
    leaseTTLMs?: number;
  } = {}) {
    this.sketch = new TopKSketch(options.sketchCapacity ?? 200);
    this.hotThreshold = options.hotThreshold ?? 20;
    this.maxLeaseBatch = options.maxLeaseBatch ?? 10;
    this.leaseTTLMs = options.leaseTTLMs ?? 1000;
  }

  recordAccess(key: string, cost: number = 1): boolean {
    this.sketch.add(key, cost);
    return this.sketch.isHot(key, this.hotThreshold);
  }

  tryConsumeLocalLease(key: string, cost: number, nowMs: number): Decision | null {
    const lease = this.leases.get(key);
    if (!lease) return null;

    if (nowMs >= lease.leaseExpiresAtMs) {
      this.leases.delete(key);
      return null;
    }

    if (lease.tokensRemaining >= cost) {
      lease.tokensRemaining -= cost;
      return {
        allowed: true,
        limit: lease.limit,
        remaining: lease.tokensRemaining,
        resetMs: lease.resetMs,
        retryAfterMs: 0,
        policyId: 'shielded_lease',
        reason: 'ok_local_shield',
        cost,
      };
    }

    // Lease exhausted
    this.leases.delete(key);
    return null;
  }

  grantLease(key: string, batchSize: number, decision: Decision, nowMs: number): void {
    if (!decision.allowed) return;
    this.leases.set(key, {
      tokensRemaining: Math.max(0, batchSize - decision.cost),
      leaseExpiresAtMs: nowMs + this.leaseTTLMs,
      limit: decision.limit,
      resetMs: decision.resetMs,
    });
  }

  clear(): void {
    this.sketch.reset();
    this.leases.clear();
  }
}
