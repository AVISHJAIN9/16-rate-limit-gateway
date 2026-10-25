import { describe, expect, it } from 'vitest';

import { FakeClock } from '../src/time/clock.js';
import {
  GCRA,
  LeakyBucket,
  TokenBucket,
  calculateRefill,
  monotonicElapsedMs
} from '../src/algorithms/index.js';

describe('batch 02 algorithm primitives', () => {
  it('uses monotonic time only and preserves exact conversions for large durations', () => {
    expect(monotonicElapsedMs(0n, 1_000_000n)).toBe(1);
    expect(monotonicElapsedMs(1_000_000n, 2_500_000n)).toBe(1);
    expect(monotonicElapsedMs(0n, 2_000_000_000n)).toBe(2_000);
    expect(monotonicElapsedMs(9_223_372_036_854_775n, 9_223_372_036_854_775n + 2_000_000n)).toBe(2);
  });

  it('calculates refill as a pure table-driven function', () => {
    expect(
      calculateRefill({
        capacity: 10,
        refillPerMs: 1,
        available: 3,
        elapsedMs: 4
      })
    ).toBe(7);

    expect(
      calculateRefill({
        capacity: 10,
        refillPerMs: 1,
        available: 2,
        elapsedMs: 1000
      })
    ).toBe(10);

    expect(
      calculateRefill({
        capacity: 10,
        refillPerMs: 1 / 3000,
        available: 0,
        elapsedMs: 3000
      })
    ).toBe(1);

    expect(
      calculateRefill({
        capacity: 10,
        refillPerMs: 0,
        available: 2,
        elapsedMs: 5000
      })
    ).toBe(2);

    expect(
      calculateRefill({
        capacity: 10,
        refillPerMs: 1,
        available: 7,
        elapsedMs: 999999999
      })
    ).toBe(10);

    expect(
      calculateRefill({
        capacity: 10,
        refillPerMs: 1,
        available: 4,
        elapsedMs: 5
      })
    ).toBe(9);
  });
});

describe('batch 02 token bucket and burst logic', () => {
  it('starts full, refills at the exact rate, and rejects over-capacity costs', () => {
    const clock = new FakeClock(0);
    const bucket = new TokenBucket({
      capacity: 10,
      refillPerMs: 1,
      initialTokens: 10,
      clock
    });

    const first = bucket.check({ cost: 2, nowMs: 0 });
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(8);
    expect(first.retryAfterMs).toBe(0);

    clock.advance(250);
    const second = bucket.check({ cost: 1, nowMs: clock.nowMs() });
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(9);

    const rejected = bucket.check({ cost: 20, nowMs: clock.nowMs() });
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
  });

  it('re-fills exactly one period after the burst is exhausted', () => {
    const clock = new FakeClock(0);
    const bucket = new TokenBucket({
      capacity: 5,
      refillPerMs: 1 / 1000,
      initialTokens: 5,
      clock
    });

    const before = bucket.check({ cost: 5, nowMs: 0 });
    expect(before.allowed).toBe(true);
    expect(before.remaining).toBe(0);

    clock.advance(1000);
    const after = bucket.check({ cost: 1, nowMs: clock.nowMs() });
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(0);
    expect(after.retryAfterMs).toBe(0);
  });

  it('validates configuration and prevents impossible burst settings', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerMs: 1, initialTokens: 0 })).toThrow();
    expect(() => new TokenBucket({ capacity: 10, refillPerMs: 0, initialTokens: 0 })).not.toThrow();
    expect(() => new TokenBucket({ capacity: 5, refillPerMs: 1, initialTokens: 6 })).toThrow();
  });
});

describe('batch 02 leaky bucket and GCRA', () => {
  it('drains by a constant rate and rejects the one extra request', () => {
    const bucket = new LeakyBucket({ capacity: 4, leakPerMs: 1, initialLevel: 3 });
    const first = bucket.check({ cost: 1, nowMs: 0 });
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(0);

    const second = bucket.check({ cost: 2, nowMs: 0 });
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });

  it('matches token bucket admit/reject decisions on a seeded random trace', () => {
    const seed = 6_123_789;
    const bucket = new TokenBucket({ capacity: 5, refillPerMs: 1, initialTokens: 5 });
    const gcra = new GCRA({ capacity: 5, ratePerSecond: 1000, initialTAT: 0 });

    let state = seed;
    let nowMs = 0;
    const decisions: Array<{ token: boolean; gcra: boolean }> = [];

    for (let i = 0; i < 100; i += 1) {
      state = (state * 1664525 + 1013904223) % 4294967296;
      const delta = (state % 300) + 1;
      nowMs += delta;
      const tokenDecision = bucket.check({ cost: 1, nowMs });
      const gcraDecision = gcra.check({ cost: 1, nowMs });
      decisions.push({ token: tokenDecision.allowed, gcra: gcraDecision.allowed });
    }

    expect(decisions.every((decision) => decision.token === decision.gcra)).toBe(true);
  });
});
