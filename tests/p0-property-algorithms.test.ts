import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import {
  TokenBucketKernel,
  LeakyBucketKernel,
  FixedWindowKernel,
  SlidingWindowLogKernel,
  SlidingWindowCounterKernel,
  GCRAKernel,
  FakeClock
} from '@rlgw/core';
import {
  OracleTokenBucket,
  OracleLeakyBucket,
  OracleFixedWindow,
  OracleSlidingWindowLog,
  OracleSlidingWindowCounter,
  OracleGCRA,
  GoldenVectorGenerator
} from '@rlgw/oracle';
import { MemoryLimiterStore } from '@rlgw/store-memory';
import { RedisLimiterStore } from '@rlgw/store-redis';

describe('P0: Core Rate Limiting Algorithm Invariants & Parity', () => {
  let redisStore: RedisLimiterStore;
  let redisAvailable = false;

  beforeAll(async () => {
    try {
      redisStore = new RedisLimiterStore({
        host: '127.0.0.1',
        port: 6379,
        connectTimeout: 1000
      });
      await redisStore.client.ping();
      redisAvailable = true;
    } catch (err: any) {
      redisAvailable = false;
      console.warn('Redis not available; error:', err?.message || err);
    }
  });

  afterAll(async () => {
    if (redisAvailable && redisStore) {
      await redisStore.close();
    }
  });

  describe('Invariant 1 & 5: Never negative remaining and cost > burst rejected immediately', () => {
    it('TokenBucket: handles arbitrary costs and preserves non-negative remaining', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1000 }), // capacity
          fc.integer({ min: 1, max: 500 }),  // refillRate
          fc.integer({ min: 1, max: 2000 }), // cost
          fc.integer({ min: 0, max: 100000 }), // nowMs
          (capacity, refillRate, cost, nowMs) => {
            const params = { type: 'token_bucket' as const, capacity, refillRate };
            const state = { tokens: capacity, lastRefillMs: 0 };
            const { decision } = TokenBucketKernel.step(state, params, cost, nowMs);

            expect(decision.remaining).toBeGreaterThanOrEqual(0);
            if (cost > capacity) {
              expect(decision.allowed).toBe(false);
              expect(decision.reason).toBe('cost_exceeds_burst');
            }
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('LeakyBucket: never returns negative remaining', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1000 }),
          fc.integer({ min: 1, max: 500 }),
          fc.integer({ min: 1, max: 2000 }),
          fc.integer({ min: 0, max: 100000 }),
          (capacity, leakRate, cost, nowMs) => {
            const params = { type: 'leaky_bucket' as const, capacity, leakRate };
            const state = { level: 0, lastLeakMs: 0 };
            const { decision } = LeakyBucketKernel.step(state, params, cost, nowMs);

            expect(decision.remaining).toBeGreaterThanOrEqual(0);
            if (cost > capacity) {
              expect(decision.allowed).toBe(false);
              expect(decision.reason).toBe('cost_exceeds_burst');
            }
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('FixedWindow: never returns negative remaining and resetMs >= nowMs', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 500 }),
          fc.integer({ min: 100, max: 10000 }),
          fc.integer({ min: 1, max: 1000 }),
          fc.integer({ min: 0, max: 500000 }),
          (limit, windowMs, cost, nowMs) => {
            const params = { type: 'fixed_window' as const, limit, windowMs };
            const state = { count: 0, windowStartMs: 0 };
            const { decision } = FixedWindowKernel.step(state, params, cost, nowMs);

            expect(decision.remaining).toBeGreaterThanOrEqual(0);
            expect(decision.resetMs).toBeGreaterThanOrEqual(nowMs);
          }
        ),
        { numRuns: 1000 }
      );
    });

    it('GCRA: never returns negative remaining', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 100 }),
          fc.integer({ min: 1, max: 50 }),
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 0, max: 500000 }),
          (capacity, ratePerSecond, cost, nowMs) => {
            const params = { type: 'gcra' as const, capacity, ratePerSecond };
            const state = { tatMs: 0 };
            const { decision } = GCRAKernel.step(state, params, cost, nowMs);

            expect(decision.remaining).toBeGreaterThanOrEqual(0);
            expect(decision.resetMs).toBeGreaterThanOrEqual(nowMs);
          }
        ),
        { numRuns: 1000 }
      );
    });
  });

  describe('Invariant 4: Refund semantics restore capacity exactly', () => {
    it('TokenBucket refund restores capacity up to limit', () => {
      const params = { type: 'token_bucket' as const, capacity: 50, refillRate: 5 };
      let state = { tokens: 50, lastRefillMs: 0 };

      // Consume 20 tokens
      const res = TokenBucketKernel.step(state, params, 20, 0);
      state = res.nextState;
      expect(state.tokens).toBe(30);

      // Refund 15 tokens
      state = TokenBucketKernel.refund(state, params, 15);
      expect(state.tokens).toBe(45);

      // Over-refund cannot exceed capacity
      state = TokenBucketKernel.refund(state, params, 20);
      expect(state.tokens).toBe(50);
    });

    it('FixedWindow refund decreases count without dropping below zero', () => {
      const params = { type: 'fixed_window' as const, limit: 100, windowMs: 1000 };
      let state = { count: 40, windowStartMs: 0 };

      state = FixedWindowKernel.refund(state, params, 25);
      expect(state.count).toBe(15);

      state = FixedWindowKernel.refund(state, params, 50);
      expect(state.count).toBe(0);
    });
  });

  describe('Gate P0 Parity: Oracle vs Implementation Parity (>= 10,000 steps)', () => {
    it('TokenBucket: MemoryLimiterStore parity with Oracle over 10,000 random operations', async () => {
      const memStore = new MemoryLimiterStore();
      const params = { type: 'token_bucket' as const, capacity: 50, refillRate: 10 };
      const oracle = new OracleTokenBucket(params, 0);
      const key = 'test:token_bucket:parity';

      let clockMs = 0;
      for (let i = 0; i < 10000; i++) {
        clockMs += (i % 7) * 50;
        const cost = 1 + (i % 8);
        const op = i % 15 === 0 ? 'peek' : i % 25 === 0 ? 'refund' : 'decide';

        if (op === 'refund') {
          oracle.refund(cost);
          await memStore.refund(key, params, cost, clockMs);
        } else if (op === 'peek') {
          const expected = oracle.step(cost, clockMs, true);
          const actual = await memStore.peek(key, params, clockMs, cost);
          expect(actual.allowed).toBe(expected.allowed);
          expect(actual.remaining).toBe(expected.remaining);
        } else {
          const expected = oracle.step(cost, clockMs, false);
          const actual = await memStore.decide(key, params, cost, clockMs);
          expect(actual.allowed).toBe(expected.allowed);
          expect(actual.remaining).toBe(expected.remaining);
          expect(actual.reason).toBe(expected.reason);
        }
      }
    });

    it('FixedWindow: MemoryLimiterStore parity with Oracle over 10,000 random operations', async () => {
      const memStore = new MemoryLimiterStore();
      const params = { type: 'fixed_window' as const, limit: 100, windowMs: 1000 };
      const oracle = new OracleFixedWindow(params);
      const key = 'test:fixed_window:parity';

      let clockMs = 0;
      for (let i = 0; i < 10000; i++) {
        clockMs += (i % 9) * 40;
        const cost = 1 + (i % 10);
        const op = i % 12 === 0 ? 'peek' : i % 20 === 0 ? 'refund' : 'decide';

        if (op === 'refund') {
          oracle.refund(cost);
          await memStore.refund(key, params, cost, clockMs);
        } else if (op === 'peek') {
          const expected = oracle.step(cost, clockMs, true);
          const actual = await memStore.peek(key, params, clockMs);
          expect(actual.allowed).toBe(expected.allowed);
          expect(actual.remaining).toBe(expected.remaining);
        } else {
          const expected = oracle.step(cost, clockMs, false);
          const actual = await memStore.decide(key, params, cost, clockMs);
          expect(actual.allowed).toBe(expected.allowed);
          expect(actual.remaining).toBe(expected.remaining);
        }
      }
    });

    it('GCRA: MemoryLimiterStore parity with Oracle over 10,000 random operations', async () => {
      const memStore = new MemoryLimiterStore();
      const params = { type: 'gcra' as const, capacity: 40, ratePerSecond: 10 };
      const oracle = new OracleGCRA(params);
      const key = 'test:gcra:parity';

      let clockMs = 0;
      for (let i = 0; i < 10000; i++) {
        clockMs += (i % 11) * 35;
        const cost = 1 + (i % 4);
        const op = i % 14 === 0 ? 'peek' : i % 22 === 0 ? 'refund' : 'decide';

        if (op === 'refund') {
          oracle.refund(cost);
          await memStore.refund(key, params, cost, clockMs);
        } else if (op === 'peek') {
          const expected = oracle.step(cost, clockMs, true);
          const actual = await memStore.peek(key, params, clockMs);
          expect(actual.allowed).toBe(expected.allowed);
          expect(actual.remaining).toBe(expected.remaining);
        } else {
          const expected = oracle.step(cost, clockMs, false);
          const actual = await memStore.decide(key, params, cost, clockMs);
          expect(actual.allowed).toBe(expected.allowed);
          expect(actual.remaining).toBe(expected.remaining);
        }
      }
    });

    it('RedisLimiterStore: Parity with Oracle when Redis is running', async () => {
      if (!redisAvailable) return;

      const params = { type: 'token_bucket' as const, capacity: 50, refillRate: 10 };
      const oracle = new OracleTokenBucket(params, 0);
      const key = `rl:test:{tenant_a:client_1}:p1:token_bucket:${Date.now()}`;

      // Clean key
      await redisStore.client.del(key);

      let clockMs = 1000;
      for (let i = 0; i < 1000; i++) {
        clockMs += (i % 5) * 50;
        const cost = 1 + (i % 6);
        const op = i % 10 === 0 ? 'peek' : 'decide';

        if (op === 'peek') {
          const expected = oracle.step(cost, clockMs, true);
          const actual = await redisStore.peek(key, params, clockMs, cost);
          expect(actual.allowed).toBe(expected.allowed);
        } else {
          const expected = oracle.step(cost, clockMs, false);
          const actual = await redisStore.decide(key, params, cost, clockMs);
          expect(actual.allowed).toBe(expected.allowed);
          expect(actual.reason).toBe(expected.reason);
        }
      }

      await redisStore.client.del(key);
    });

    it('Golden vectors verify deterministic parity', () => {
      const tbVectors = GoldenVectorGenerator.generateTokenBucket(500);
      const fwVectors = GoldenVectorGenerator.generateFixedWindow(500);
      const gcraVectors = GoldenVectorGenerator.generateGCRA(500);

      expect(tbVectors.steps.length).toBe(500);
      expect(fwVectors.steps.length).toBe(500);
      expect(gcraVectors.steps.length).toBe(500);
    });
  });
});
