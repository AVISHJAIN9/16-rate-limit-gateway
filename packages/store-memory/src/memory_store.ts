import {
  type LimiterStore,
  type AlgorithmSpec,
  type Decision,
  TokenBucketKernel,
  LeakyBucketKernel,
  FixedWindowKernel,
  SlidingWindowLogKernel,
  SlidingWindowCounterKernel,
  GCRAKernel
} from '@rlgw/core';

interface MemoryEntry {
  state: any;
  lastAccessMs: number;
  expiresAtMs: number;
}

export interface MemoryStoreOptions {
  maxKeys?: number;
  ttlMs?: number;
}

export class MemoryLimiterStore implements LimiterStore {
  private readonly store = new Map<string, MemoryEntry>();
  private readonly maxKeys: number;
  private readonly defaultTtlMs: number;

  constructor(options: MemoryStoreOptions = {}) {
    this.maxKeys = options.maxKeys ?? 100000;
    this.defaultTtlMs = options.ttlMs ?? 3600000; // 1 hour default
  }

  async decide(key: string, spec: AlgorithmSpec, cost: number, nowMs: number): Promise<Decision> {
    return this.stepInternal(key, spec, cost, nowMs, false);
  }

  async peek(key: string, spec: AlgorithmSpec, nowMs: number, cost = 1): Promise<Decision> {
    return this.stepInternal(key, spec, cost, nowMs, true);
  }

  async commit(key: string, spec: AlgorithmSpec, cost: number, nowMs: number): Promise<Decision> {
    return this.stepInternal(key, spec, cost, nowMs, false);
  }

  async refund(key: string, spec: AlgorithmSpec, cost: number, _nowMs: number): Promise<void> {
    const entry = this.store.get(key);
    if (!entry) return;

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

  private stepInternal(
    key: string,
    spec: AlgorithmSpec,
    cost: number,
    nowMs: number,
    peekOnly: boolean
  ): Decision {
    this.evictExpiredOrOverflow(nowMs);

    let entry = this.store.get(key);
    if (entry && entry.expiresAtMs <= nowMs) {
      this.store.delete(key);
      entry = undefined;
    }

    const state = entry ? entry.state : this.getInitialState(spec, nowMs);

    let nextState: any;
    let decision: Decision;

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
        throw new Error(`Unsupported algorithm type: ${(spec as any).type}`);
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

  private getInitialState(spec: AlgorithmSpec, nowMs: number): any {
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

  private computeTtl(spec: AlgorithmSpec, decision: Decision, nowMs: number): number {
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

  private evictExpiredOrOverflow(nowMs: number): void {
    if (this.store.size < this.maxKeys) return;

    // Sweep expired
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        this.store.delete(key);
      }
    }

    // If still over maxKeys, LRU-evict 10%
    if (this.store.size >= this.maxKeys) {
      const entries = Array.from(this.store.entries()).sort(
        (a, b) => a[1].lastAccessMs - b[1].lastAccessMs
      );
      const toDelete = Math.ceil(this.maxKeys * 0.1);
      for (let i = 0; i < toDelete && i < entries.length; i++) {
        this.store.delete(entries[i][0]);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}
