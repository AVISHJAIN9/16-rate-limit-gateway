import { TopKSketch } from './top_k.js';
export class HotKeyShield {
    sketch;
    leases = new Map();
    hotThreshold;
    maxLeaseBatch;
    leaseTTLMs;
    constructor(options = {}) {
        this.sketch = new TopKSketch(options.sketchCapacity ?? 200);
        this.hotThreshold = options.hotThreshold ?? 20;
        this.maxLeaseBatch = options.maxLeaseBatch ?? 10;
        this.leaseTTLMs = options.leaseTTLMs ?? 1000;
    }
    recordAccess(key, cost = 1) {
        this.sketch.add(key, cost);
        return this.sketch.isHot(key, this.hotThreshold);
    }
    tryConsumeLocalLease(key, cost, nowMs) {
        const lease = this.leases.get(key);
        if (!lease)
            return null;
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
    grantLease(key, batchSize, decision, nowMs) {
        if (!decision.allowed)
            return;
        this.leases.set(key, {
            tokensRemaining: Math.max(0, batchSize - decision.cost),
            leaseExpiresAtMs: nowMs + this.leaseTTLMs,
            limit: decision.limit,
            resetMs: decision.resetMs,
        });
    }
    clear() {
        this.sketch.reset();
        this.leases.clear();
    }
}
