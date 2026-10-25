import { TokenBucketKernel, LeakyBucketKernel, FixedWindowKernel, SlidingWindowLogKernel, SlidingWindowCounterKernel, GCRAKernel } from '@rlgw/core';
export class MemoryLimiterStore {
    store = new Map();
    maxKeys;
    defaultTtlMs;
    constructor(options = {}) {
        this.maxKeys = options.maxKeys ?? 100000;
        this.defaultTtlMs = options.ttlMs ?? 3600000; // 1 hour default
    }
    async decide(key, spec, cost, nowMs) {
        return this.stepInternal(key, spec, cost, nowMs, false);
    }
    async peek(key, spec, nowMs, cost = 1) {
        return this.stepInternal(key, spec, cost, nowMs, true);
    }
    async commit(key, spec, cost, nowMs) {
        return this.stepInternal(key, spec, cost, nowMs, false);
    }
    async refund(key, spec, cost, _nowMs) {
        const entry = this.store.get(key);
        if (!entry)
            return;
        switch (spec.type) {
            case 'token_bucket':
                entry.state = TokenBucketKernel.refund(entry.state, spec, cost);
                break;
            case 'leaky_bucket':
                entry.state = LeakyBucketKernel.refund(entry.state, spec, cost);
                break;
            case 'fixed_window':
                entry.state = FixedWindowKernel.refund(entry.state, spec, cost);
                break;
            case 'sliding_window_log':
                entry.state = SlidingWindowLogKernel.refund(entry.state, spec, cost);
                break;
            case 'sliding_window_counter':
                entry.state = SlidingWindowCounterKernel.refund(entry.state, spec, cost);
                break;
            case 'gcra':
                entry.state = GCRAKernel.refund(entry.state, spec, cost);
                break;
        }
    }
    stepInternal(key, spec, cost, nowMs, peekOnly) {
        this.evictExpiredOrOverflow(nowMs);
        let entry = this.store.get(key);
        if (entry && entry.expiresAtMs <= nowMs) {
            this.store.delete(key);
            entry = undefined;
        }
        const state = entry ? entry.state : this.getInitialState(spec, nowMs);
        let nextState;
        let decision;
        switch (spec.type) {
            case 'token_bucket': {
                const result = TokenBucketKernel.step(state, spec, cost, nowMs, peekOnly);
                nextState = result.nextState;
                decision = result.decision;
                break;
            }
            case 'leaky_bucket': {
                const result = LeakyBucketKernel.step(state, spec, cost, nowMs, peekOnly);
                nextState = result.nextState;
                decision = result.decision;
                break;
            }
            case 'fixed_window': {
                const result = FixedWindowKernel.step(state, spec, cost, nowMs, peekOnly);
                nextState = result.nextState;
                decision = result.decision;
                break;
            }
            case 'sliding_window_log': {
                const result = SlidingWindowLogKernel.step(state, spec, cost, nowMs, peekOnly);
                nextState = result.nextState;
                decision = result.decision;
                break;
            }
            case 'sliding_window_counter': {
                const result = SlidingWindowCounterKernel.step(state, spec, cost, nowMs, peekOnly);
                nextState = result.nextState;
                decision = result.decision;
                break;
            }
            case 'gcra': {
                const result = GCRAKernel.step(state, spec, cost, nowMs, peekOnly);
                nextState = result.nextState;
                decision = result.decision;
                break;
            }
            default:
                throw new Error(`Unsupported algorithm type: ${spec.type}`);
        }
        if (!peekOnly) {
            const ttlMs = this.computeTtl(spec, decision, nowMs);
            this.store.set(key, {
                state: nextState,
                lastAccessMs: nowMs,
                expiresAtMs: nowMs + ttlMs
            });
        }
        return decision;
    }
    getInitialState(spec, nowMs) {
        switch (spec.type) {
            case 'token_bucket':
                return { tokens: spec.capacity, lastRefillMs: nowMs };
            case 'leaky_bucket':
                return { level: 0, lastLeakMs: nowMs };
            case 'fixed_window':
                return { count: 0, windowStartMs: Math.floor(nowMs / spec.windowMs) * spec.windowMs };
            case 'sliding_window_log':
                return { entries: [] };
            case 'sliding_window_counter':
                return { prevCount: 0, currCount: 0, currWindowStartMs: Math.floor(nowMs / spec.windowMs) * spec.windowMs };
            case 'gcra':
                return { tatMs: nowMs };
        }
    }
    computeTtl(spec, decision, nowMs) {
        switch (spec.type) {
            case 'fixed_window':
                return spec.windowMs * 2;
            case 'sliding_window_log':
            case 'sliding_window_counter':
                return spec.windowMs * 2;
            case 'token_bucket':
                return spec.refillRate > 0 ? Math.ceil((spec.capacity / spec.refillRate) * 1000) * 2 : this.defaultTtlMs;
            case 'leaky_bucket':
                return spec.leakRate > 0 ? Math.ceil((spec.capacity / spec.leakRate) * 1000) * 2 : this.defaultTtlMs;
            case 'gcra':
                return Math.max(this.defaultTtlMs, decision.resetMs - nowMs + 10000);
            default:
                return this.defaultTtlMs;
        }
    }
    evictExpiredOrOverflow(nowMs) {
        if (this.store.size < this.maxKeys)
            return;
        // Sweep expired
        for (const [key, entry] of this.store.entries()) {
            if (entry.expiresAtMs <= nowMs) {
                this.store.delete(key);
            }
        }
        // If still over maxKeys, LRU-evict 10%
        if (this.store.size >= this.maxKeys) {
            const entries = Array.from(this.store.entries()).sort((a, b) => a[1].lastAccessMs - b[1].lastAccessMs);
            const toDelete = Math.ceil(this.maxKeys * 0.1);
            for (let i = 0; i < toDelete && i < entries.length; i++) {
                this.store.delete(entries[i][0]);
            }
        }
    }
    clear() {
        this.store.clear();
    }
    size() {
        return this.store.size;
    }
}
