export class GCRAKernel {
    static step(state, params, cost, nowMs, peekOnly = false) {
        const { capacity, ratePerSecond } = params;
        const emissionIntervalMs = 1000 / ratePerSecond;
        const burstToleranceMs = (capacity - 1) * emissionIntervalMs;
        const currentTat = state.tatMs <= 0 ? nowMs : state.tatMs;
        const earliestEligibleMs = currentTat - burstToleranceMs;
        if (nowMs >= earliestEligibleMs) {
            const incrementMs = emissionIntervalMs * cost;
            const nextTatMs = Math.max(nowMs, currentTat) + (peekOnly ? 0 : incrementMs);
            const remainingMs = Math.max(0, (nextTatMs - nowMs));
            const remainingCells = Math.max(0, Math.floor((burstToleranceMs - remainingMs) / emissionIntervalMs));
            return {
                nextState: { tatMs: nextTatMs },
                decision: {
                    allowed: true,
                    limit: capacity,
                    remaining: remainingCells,
                    resetMs: nextTatMs,
                    retryAfterMs: 0,
                    policyId: 'gcra',
                    reason: 'ok',
                    cost,
                    burst: capacity
                }
            };
        }
        const retryAfterMs = Math.max(0, Math.ceil(earliestEligibleMs - nowMs));
        return {
            nextState: { tatMs: currentTat },
            decision: {
                allowed: false,
                limit: capacity,
                remaining: 0,
                resetMs: nowMs + retryAfterMs,
                retryAfterMs,
                policyId: 'gcra',
                reason: 'limit_exceeded',
                cost,
                burst: capacity
            }
        };
    }
    static refund(state, params, cost) {
        const emissionIntervalMs = 1000 / params.ratePerSecond;
        return {
            tatMs: Math.max(0, state.tatMs - emissionIntervalMs * cost)
        };
    }
}
