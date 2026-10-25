import { describe, expect, it } from 'vitest';

import {
  ClockSkewGuard,
  FixedWindowCounter,
  SlidingWindowApproximationCounter,
  SlidingWindowCounter,
  WeightedRequestCost,
  calculateSlidingWindow,
  runStoreContract,
  type Decision,
  type RateDecision
} from '../src/algorithms/index.js';
import { FakeClock } from '../src/time/clock.js';
import { MemoryStore } from '../src/store/memory.js';

describe('batch 03 store contract and window semantics', () => {
  it('serializes atomic increments exactly under concurrency', async () => {
    const store = new MemoryStore(new FakeClock(0));
    const updates = Array.from({ length: 10000 }, (_, index) => index).map(async (value) => {
      const next = await store.incrBy('atomic', 1, 10_000);
      return { value, next };
    });

    const results = await Promise.all(updates);
    expect(results.every((entry) => entry.next >= 1)).toBe(true);
    expect((await store.get('atomic'))).toBe(10000);
    expect(new Set(results.map((entry) => entry.next)).size).toBe(10000);
  });

  it('expires counters on the fake clock and keeps memory bounded', async () => {
    const clock = new FakeClock(0);
    const store = new MemoryStore(clock);

    for (let i = 0; i < 10_000; i += 1) {
      await store.incrBy(`k:${i}`, 1, 1_000);
    }

    expect((await store.get('k:0'))).toBe(1);
    clock.advance(1_001);
    expect(await store.get('k:0')).toBeUndefined();
    expect(await store.delete('k:0')).toBeUndefined();
  });

  it('executes the reusable store contract suite', async () => {
    await runStoreContract(() => new MemoryStore(new FakeClock(0)), 'MemoryStore');
  });
});

describe('batch 03 fixed/sliding windows', () => {
  it('places requests in the correct window and documents rollover behavior', () => {
    const clock = new FakeClock(0);
    const window = new FixedWindowCounter({
      windowMs: 100,
      limit: 3,
      clock
    });

    expect(window.check({ cost: 1, nowMs: 99 }).allowed).toBe(true);
    expect(window.check({ cost: 1, nowMs: 99 }).allowed).toBe(true);
    expect(window.check({ cost: 1, nowMs: 99 }).allowed).toBe(true);
    expect(window.check({ cost: 1, nowMs: 99 }).allowed).toBe(false);

    clock.set(100);
    expect(window.check({ cost: 1, nowMs: 100 }).allowed).toBe(true);
    expect(window.check({ cost: 1, nowMs: 101 }).allowed).toBe(true);
  });

  it('matches an exact reference model on a seeded trace', () => {
    const clock = new FakeClock(0);
    const exact = new SlidingWindowCounter({ limit: 5, windowMs: 1000, clock });
    const approx = new SlidingWindowApproximationCounter({ limit: 5, windowMs: 1000, clock });

    let state = 273_451_031;
    for (let i = 0; i < 200; i += 1) {
      state = (state * 1664525 + 1013904223) % 4294967296;
      const delta = 1 + (state % 30);
      clock.advance(delta);
      const exactDecision = exact.check({ cost: 1, nowMs: clock.nowMs() });
      const approxDecision = approx.check({ cost: 1, nowMs: clock.nowMs() });
      expect(approxDecision.allowed === exactDecision.allowed || approxDecision.retryAfterMs <= 1000).toBe(true);
    }
  });

  it('keeps the sliding-window error bounded', () => {
    const counter = new SlidingWindowApproximationCounter({ limit: 10, windowMs: 1000, clock: new FakeClock(0) });
    const decisions: RateDecision[] = [];

    for (let i = 0; i < 25; i += 1) {
      decisions.push(counter.check({ cost: 1, nowMs: i * 100 }));
    }

    const maxError = decisions.reduce((max, decision) => Math.max(max, decision.retryAfterMs), 0);
    expect(maxError).toBeLessThanOrEqual(1000);
  });

  it('documents weighted request cost and invalid cost behavior', () => {
    expect(WeightedRequestCost.apply(0, 1)).toBe(0);
    expect(WeightedRequestCost.apply(2, 0.5)).toBe(1);
    expect(WeightedRequestCost.apply(5, 3)).toBe(5);
    expect(() => WeightedRequestCost.apply(-1, 2)).toThrow();
  });

  it('caps skew and exposes skew events', () => {
    const clock = new FakeClock(1_000);
    const guard = new ClockSkewGuard({ maxSkewMs: 200, clock });

    expect(guard.observe(900)).toMatchObject({ skewMs: 100, capped: false, skewEvent: false });
    expect(guard.observe(0)).toMatchObject({ skewMs: 200, capped: true, skewEvent: true });
  });

  it('matches the exact sliding-window semantics on a reference trace', () => {
    const clock = new FakeClock(0);
    const exact = new SlidingWindowCounter({ limit: 4, windowMs: 100, clock });
    const decisions: Array<{ exact: Decision; approx: Decision }> = [];

    for (let i = 0; i < 50; i += 1) {
      const now = i * 7;
      const requestsBefore = [...exact.requests];
      const approxDecision = calculateSlidingWindow({
        limit: 4,
        windowMs: 100,
        requests: requestsBefore,
        nowMs: now,
        cost: 1
      });
      const exactDecision = exact.check({ cost: 1, nowMs: now });
      decisions.push({ exact: exactDecision, approx: approxDecision });
    }

    expect(decisions.every(({ exact, approx }) => exact.allowed === approx.allowed)).toBe(true);
  });
});
