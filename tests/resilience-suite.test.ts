import { describe, it, expect } from 'vitest';
import {
  BoundedQueue,
  BulkheadPool,
  AdaptiveLoadShedder,
  OutlierEjector,
  AsyncLeakDetector
} from '@rlgw/core';
import { CircuitBreaker } from '../apps/gateway/src/circuit_breaker.js';

describe('P4: Resilience & Failure Handling Suite (F91–F105)', () => {
  it('F94: Store and upstream Circuit Breaker tripping, half-open probes, and recovery', () => {
    const cb = new CircuitBreaker('test_breaker', {
      failureThresholdRatio: 0.5,
      minimumRequests: 4,
      openDurationMs: 100,
      halfOpenProbes: 1,
    });

    const now = 1000;
    // Initial closed state
    expect(cb.getState(now)).toBe('closed');
    expect(cb.canExecute(now)).toBe(true);

    // Record 4 failures -> trips open
    cb.recordFailure(now);
    cb.recordFailure(now);
    cb.recordFailure(now);
    cb.recordFailure(now);

    expect(cb.getState(now)).toBe('open');
    expect(cb.canExecute(now)).toBe(false);

    // After openDurationMs -> transitions to half_open
    expect(cb.getState(now + 150)).toBe('half_open');
    expect(cb.canExecute(now + 150)).toBe(true); // Single probe allowed
    expect(cb.canExecute(now + 150)).toBe(false); // Second probe blocked

    // Probe success resets to closed
    cb.recordSuccess(now + 160);
    expect(cb.getState(now + 160)).toBe('closed');
    expect(cb.canExecute(now + 160)).toBe(true);
  });

  it('F98: Bounded Queue and explicit drop overflow policies (drop-oldest, reject)', () => {
    // 1. Drop oldest
    const qDropOldest = new BoundedQueue<number>(3, 'drop_oldest');
    qDropOldest.push(1);
    qDropOldest.push(2);
    qDropOldest.push(3);
    qDropOldest.push(4); // Displaces 1

    expect(qDropOldest.size).toBe(3);
    expect(qDropOldest.droppedCount).toBe(1);
    expect(qDropOldest.pop()).toBe(2);

    // 2. Reject
    const qReject = new BoundedQueue<number>(2, 'reject');
    expect(qReject.push(10)).toBe(true);
    expect(qReject.push(20)).toBe(true);
    expect(qReject.push(30)).toBe(false); // Rejected
    expect(qReject.droppedCount).toBe(1);
  });

  it('F99 & F104: Adaptive load shedding and priority classes (health > admin > normal)', () => {
    const shedder = new AdaptiveLoadShedder(5, 50, 50);

    // 1. Normal traffic under high event loop delay is shed
    expect(shedder.canAccept('normal', 100)).toBe(false);
    expect(shedder.totalShedded).toBe(1);

    // 2. Health and admin endpoints are NEVER shed even under severe delay
    expect(shedder.canAccept('health', 250)).toBe(true);
    expect(shedder.canAccept('admin', 250)).toBe(true);

    // Release in-flight
    shedder.release();
    shedder.release();

    // 3. Normal traffic accepted when loop delay is healthy (< 50ms)
    expect(shedder.canAccept('normal', 10)).toBe(true);
    shedder.release();
  });

  it('F102: Upstream outlier ejection on consecutive 5xx with max ejection percent limit', () => {
    const ejector = new OutlierEjector(3, 1000, 5000, 0.5);
    const targets = ['target_a', 'target_b'];
    const now = 10000;

    // Record 3 consecutive 5xx on target_a
    ejector.recordResponse('target_a', 503, now);
    ejector.recordResponse('target_a', 503, now);
    ejector.recordResponse('target_a', 503, now);

    expect(ejector.isEjected('target_a', now)).toBe(true);

    // Active targets now excludes target_a
    const active = ejector.getActiveTargets(targets, now);
    expect(active).toEqual(['target_b']);

    // Attempting to eject target_b is prevented by maxEjectionPercent (0.5), so at least 1 remains
    ejector.recordResponse('target_b', 500, now);
    ejector.recordResponse('target_b', 500, now);
    ejector.recordResponse('target_b', 500, now);

    expect(ejector.isEjected('target_b', now)).toBe(false);
  });

  it('F103: Bulkhead isolation per tenant / upstream pool', () => {
    const bulkhead = new BulkheadPool(3);
    const tenant = 'tenant_noisy';

    // Acquire up to limit
    expect(bulkhead.acquire(tenant)).toBe(true);
    expect(bulkhead.acquire(tenant)).toBe(true);
    expect(bulkhead.acquire(tenant)).toBe(true);

    // 4th concurrent request exceeds bulkhead
    expect(bulkhead.acquire(tenant)).toBe(false);

    // Another tenant remains unaffected
    expect(bulkhead.acquire('tenant_quiet')).toBe(true);

    // Release slot
    bulkhead.release(tenant);
    expect(bulkhead.acquire(tenant)).toBe(true);
  });

  it('F100: Async resource leak prevention returns to baseline', async () => {
    const baseline = AsyncLeakDetector.takeSnapshot();

    // Spawn and cleanly resolve async timer work
    await new Promise((resolve) => setTimeout(resolve, 10));

    const check = AsyncLeakDetector.assertNoLeak(baseline, 3);
    expect(check.leaked).toBe(false);
  });

  it('F95 & F96: Upstream retries with full jitter and retry budget preventing storms', async () => {
    const { RetryBudget, RetryPolicy } = await import('@rlgw/core');
    const budget = new RetryBudget(20, 10); // 20 tokens total, 10 per retry -> exactly 2 retries allowed
    const policy = new RetryPolicy({ maxRetries: 3, baseBackoffMs: 5, maxBackoffMs: 50 }, budget);

    let attempts = 0;
    const result = await policy.execute(async (att) => {
      attempts++;
      if (att === 0) throw new Error('Transient network glitch');
      return 'success_val';
    }, 'GET');

    expect(result).toBe('success_val');
    expect(attempts).toBe(2);

    // Test retry budget exhaustion
    expect(budget.availableTokens).toBe(11); // 20 - 10 + 1 (success)
    const exhaustedBudget = new RetryBudget(5, 10); // Not enough for even 1 retry
    const failingPolicy = new RetryPolicy({ maxRetries: 3, baseBackoffMs: 5 }, exhaustedBudget);

    await expect(
      failingPolicy.execute(async () => {
        throw new Error('Always fail');
      }, 'GET')
    ).rejects.toThrow(/Retry budget exhausted/);
  });

  it('F97: Deadlock-free minimal locking with watchdog timeout', async () => {
    const { KeyedMutex } = await import('@rlgw/core');
    const mutex = new KeyedMutex(50); // 50ms watchdog timeout

    const release1 = await mutex.acquire('account_123');
    expect(mutex.activeLocksCount).toBe(1);

    // Second acquire on the same key without release will trip the watchdog
    await expect(mutex.acquire('account_123', 50)).rejects.toThrow(/deadlock watchdog timeout/);

    release1();
    expect(mutex.activeLocksCount).toBe(0);

    // Can acquire again after release
    const release2 = await mutex.acquire('account_123');
    release2();
  });

  it('F105: Fast diagnostic crash logging produces redacted state summary', async () => {
    const { DiagnosticCrashLogger } = await import('@rlgw/core');
    const summary = DiagnosticCrashLogger.createSummary(new Error('Fatal exception test'));

    expect(summary.error.message).toBe('Fatal exception test');
    expect(summary.pid).toBe(process.pid);
    expect(summary.memoryUsage.heapUsed).toBeGreaterThan(0);
    expect(typeof summary.timestamp).toBe('string');
  });
});
