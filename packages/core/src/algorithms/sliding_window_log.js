export class SlidingWindowLogKernel {
    static step(state, params, cost, nowMs, peekOnly = false) {
        const { limit, windowMs, maxEntries = 10000 } = params;
        const cutoff = nowMs - windowMs;
        // Filter active entries within current window
        const activeEntries = state.entries.filter((entry) => entry.timestampMs > cutoff && entry.timestampMs <= nowMs);
        const currentCost = activeEntries.reduce((sum, entry) => sum + entry.cost, 0);
        if (currentCost + cost <= limit) {
            const nextEntries = peekOnly ? [...activeEntries] : [...activeEntries, { timestampMs: nowMs, cost }];
            if (nextEntries.length > maxEntries) {
                nextEntries.splice(0, nextEntries.length - maxEntries);
            }
            return {
                nextState: { entries: nextEntries },
                decision: {
                    allowed: true,
                    limit,
                    remaining: Math.max(0, limit - (currentCost + (peekOnly ? 0 : cost))),
                    resetMs: activeEntries.length > 0 ? activeEntries[0].timestampMs + windowMs : nowMs + windowMs,
                    retryAfterMs: 0,
                    policyId: 'sliding_window_log',
                    reason: 'ok',
                    cost
                }
            };
        }
        // Calculate when enough entries expire for this cost to fit
        let neededToFree = (currentCost + cost) - limit;
        let retryAfterMs = windowMs;
        for (const entry of activeEntries) {
            neededToFree -= entry.cost;
            if (neededToFree <= 0) {
                retryAfterMs = Math.max(0, (entry.timestampMs + windowMs) - nowMs);
                break;
            }
        }
        return {
            nextState: { entries: activeEntries },
            decision: {
                allowed: false,
                limit,
                remaining: Math.max(0, limit - currentCost),
                resetMs: nowMs + retryAfterMs,
                retryAfterMs,
                policyId: 'sliding_window_log',
                reason: 'limit_exceeded',
                cost
            }
        };
    }
    static refund(state, _params, cost) {
        const entries = [...state.entries];
        // Remove cost from the most recent entries
        let remainingToRefund = cost;
        for (let i = entries.length - 1; i >= 0 && remainingToRefund > 0; i--) {
            if (entries[i].cost <= remainingToRefund) {
                remainingToRefund -= entries[i].cost;
                entries.splice(i, 1);
            }
            else {
                entries[i].cost -= remainingToRefund;
                remainingToRefund = 0;
            }
        }
        return { entries };
    }
}
