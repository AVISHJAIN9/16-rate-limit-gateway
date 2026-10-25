import { defaultClock } from '@rlgw/core';
export class HistoryStore {
    // Fixed memory buffer: 720 slots for 5s intervals (1 hour)
    points5s = [];
    maxPoints = 720;
    clientCounts = new Map(); // tenant -> clientId -> count
    reasonCounts = new Map(); // tenant -> reason -> count
    policyCounts = new Map(); // tenant -> policyId -> count
    retryAfterStats = { under1s: 0, from1sTo5s: 0, over5s: 0 };
    latenciesSample = [];
    clock;
    constructor(clock = defaultClock) {
        this.clock = clock;
    }
    record(event) {
        const bucketTs = Math.floor(event.timestampMs / 5000) * 5000;
        let point = this.points5s.find((p) => p.ts === bucketTs);
        if (!point) {
            point = {
                ts: bucketTs,
                totalRequests: 0,
                allowedRequests: 0,
                deniedRequests: 0,
                latencySumUs: 0,
                maxLatencyUs: 0
            };
            this.points5s.push(point);
            if (this.points5s.length > this.maxPoints) {
                this.points5s.shift(); // Drop oldest fixed-memory bucket
            }
        }
        point.totalRequests++;
        if (event.allowed) {
            point.allowedRequests++;
        }
        else {
            point.deniedRequests++;
        }
        point.latencySumUs += event.latencyUs;
        point.maxLatencyUs = Math.max(point.maxLatencyUs, event.latencyUs);
        // Track latencies sample for quantiles (bounded to 5000 items)
        if (this.latenciesSample.length < 5000) {
            this.latenciesSample.push(event.latencyUs);
        }
        // Tenant breakdown: clients
        let tClients = this.clientCounts.get(event.tenant);
        if (!tClients) {
            tClients = new Map();
            this.clientCounts.set(event.tenant, tClients);
        }
        tClients.set(event.clientId, (tClients.get(event.clientId) ?? 0) + 1);
        // Tenant breakdown: reasons
        if (event.reason) {
            let tReasons = this.reasonCounts.get(event.tenant);
            if (!tReasons) {
                tReasons = new Map();
                this.reasonCounts.set(event.tenant, tReasons);
            }
            tReasons.set(event.reason, (tReasons.get(event.reason) ?? 0) + 1);
        }
        // Tenant breakdown: policies
        let tPolicies = this.policyCounts.get(event.tenant);
        if (!tPolicies) {
            tPolicies = new Map();
            this.policyCounts.set(event.tenant, tPolicies);
        }
        tPolicies.set(event.policyId, (tPolicies.get(event.policyId) ?? 0) + 1);
        // Retry-After distribution
        if (event.retryAfterMs !== undefined && event.retryAfterMs > 0) {
            if (event.retryAfterMs <= 1000) {
                this.retryAfterStats.under1s++;
            }
            else if (event.retryAfterMs <= 5000) {
                this.retryAfterStats.from1sTo5s++;
            }
            else {
                this.retryAfterStats.over5s++;
            }
        }
    }
    getTimeseries(rangeMinutes = 60) {
        const cutoff = this.clock.nowMs() - rangeMinutes * 60 * 1000;
        return this.points5s.filter((p) => p.ts >= cutoff);
    }
    getTopClients(tenant, limit = 10) {
        const clients = this.clientCounts.get(tenant);
        if (!clients)
            return [];
        return Array.from(clients.entries())
            .map(([clientId, requests]) => ({ clientId, requests }))
            .sort((a, b) => b.requests - a.requests)
            .slice(0, limit);
    }
    getAnalyticsSummary(tenant) {
        let totalReq = 0;
        let allowed = 0;
        let denied = 0;
        let maxLatency = 0;
        for (const p of this.points5s) {
            totalReq += p.totalRequests;
            allowed += p.allowedRequests;
            denied += p.deniedRequests;
            maxLatency = Math.max(maxLatency, p.maxLatencyUs);
        }
        const sortedLatencies = [...this.latenciesSample].sort((a, b) => a - b);
        const p50 = sortedLatencies.length > 0 ? sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] : 0;
        const p95 = sortedLatencies.length > 0 ? sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] : 0;
        const reasonsObj = {};
        const tReasons = this.reasonCounts.get(tenant);
        if (tReasons) {
            for (const [r, c] of tReasons.entries()) {
                reasonsObj[r] = c;
            }
        }
        const policiesObj = {};
        const tPolicies = this.policyCounts.get(tenant);
        if (tPolicies) {
            for (const [pol, c] of tPolicies.entries()) {
                policiesObj[pol] = c;
            }
        }
        return {
            tenant,
            totalRequests: totalReq,
            allowed,
            denied,
            rejectRatio: totalReq > 0 ? denied / totalReq : 0,
            latencyUsP50: p50,
            latencyUsP95: p95,
            latencyUsMax: maxLatency,
            reasonBreakdown: reasonsObj,
            policyBreakdown: policiesObj,
            retryAfterDistribution: { ...this.retryAfterStats }
        };
    }
    getSummary(tenant = 'global') {
        return this.getAnalyticsSummary(tenant);
    }
    getTopReasons(tenant, limit = 10) {
        const reasons = this.reasonCounts.get(tenant);
        if (!reasons)
            return [];
        return Array.from(reasons.entries())
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
    }
    get points() {
        return this.points5s;
    }
}
