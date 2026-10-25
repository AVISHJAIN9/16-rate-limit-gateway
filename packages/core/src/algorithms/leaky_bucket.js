export class LeakyBucketKernel {
    static step(state, params, cost, nowMs, peekOnly = false) {
        const { capacity, leakRate, variant = 'policing' } = params;
        if (cost > capacity) {
            return {
                nextState: { ...state },
                decision: {
                    allowed: false,
                    limit: capacity,
                    remaining: Math.max(0, capacity - state.level),
                    resetMs: nowMs,
                    retryAfterMs: Number.POSITIVE_INFINITY,
                    policyId: 'leaky_bucket',
                    reason: 'cost_exceeds_burst',
                    cost,
                    burst: capacity
                }
            };
        }
        const elapsedMs = Math.max(0, nowMs - state.lastLeakMs);
        const leaked = elapsedMs * (leakRate / 1000);
        const currentLevel = Math.max(0, state.level - leaked);
        if (currentLevel + cost <= capacity) {
            const nextLevel = currentLevel + (peekOnly ? 0 : cost);
            return {
                nextState: {
                    level: nextLevel,
                    lastLeakMs: nowMs
                },
                decision: {
                    allowed: true,
                    limit: capacity,
                    remaining: Math.max(0, capacity - nextLevel),
                    resetMs: nowMs + (leakRate > 0 ? Math.ceil((nextLevel / leakRate) * 1000) : 0),
                    retryAfterMs: 0,
                    policyId: 'leaky_bucket',
                    reason: 'ok',
                    cost,
                    burst: capacity
                }
            };
        }
        const excess = (currentLevel + cost) - capacity;
        const retryAfterMs = leakRate > 0 ? Math.ceil((excess / leakRate) * 1000) : Number.POSITIVE_INFINITY;
        return {
            nextState: {
                level: currentLevel,
                lastLeakMs: nowMs
            },
            decision: {
                allowed: false,
                limit: capacity,
                remaining: Math.max(0, capacity - currentLevel),
                resetMs: nowMs + (Number.isFinite(retryAfterMs) ? retryAfterMs : 0),
                retryAfterMs,
                policyId: 'leaky_bucket',
                reason: variant === 'shaping' ? 'delayed' : 'limit_exceeded',
                cost,
                burst: capacity
            }
        };
    }
    static refund(state, _params, cost) {
        return {
            ...state,
            level: Math.max(0, state.level - cost)
        };
    }
}
