import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import IORedis from 'ioredis';
import {
  RedisLimiterStore,
  TopKSketch,
  HotKeyShield,
  PipelineBatcher,
  ShardedCounterKeyer
} from '@rlgw/store-redis';
import { FaultInjectingProxy } from '@rlgw/testutil';
import type { AlgorithmSpec } from '@rlgw/core';

const RedisClass: any = (IORedis as any).default ?? IORedis;

describe('P2: Redis Store Completion (F31–F45)', () => {
  let redisClient: any;
  let faultProxy: FaultInjectingProxy;
  let proxyPort: number;

  beforeAll(async () => {
    redisClient = new RedisClass({ host: '127.0.0.1', port: 6379, maxRetriesPerRequest: 1 });
    faultProxy = new FaultInjectingProxy('127.0.0.1', 6379);
    proxyPort = await faultProxy.start();
  });

  afterAll(async () => {
    await redisClient.quit();
    await faultProxy.close();
  });

  it('F31: Single-node connector health ping, config, and clean shutdown', async () => {
    const store = new RedisLimiterStore({ host: '127.0.0.1', port: 6379 });
    const pong = await store.ping();
    expect(pong).toBe('PONG');
    await store.close();
  });

  it('F34 & F36: SCRIPT FLUSH resilience mid-traffic without decision loss', async () => {
    const store = new RedisLimiterStore({ host: '127.0.0.1', port: 6379 });
    const key = `test:script_flush:${Date.now()}`;
    const spec: AlgorithmSpec = { type: 'token_bucket', capacity: 100, refillRate: 10 };

    // 1. First decision loads script
    const d1 = await store.decide(key, spec, 1, 1000);
    expect(d1.allowed).toBe(true);

    // 2. Inject SCRIPT FLUSH on live Redis
    await redisClient.script('FLUSH');

    // 3. Next decision must recover automatically without throwing
    const d2 = await store.decide(key, spec, 1, 1000);
    expect(d2.allowed).toBe(true);
    expect(store.scriptFlushReloadsCount).toBeGreaterThanOrEqual(1);

    await store.close();
  });

  it('F37: Sorted-set sliding log trimming and bounded cardinality', async () => {
    const store = new RedisLimiterStore({ host: '127.0.0.1', port: 6379 });
    const key = `test:zset_trim:${Date.now()}`;
    const spec: AlgorithmSpec = {
      type: 'sliding_window_log',
      limit: 100,
      windowMs: 1000,
      maxEntries: 10,
    };

    // Add 15 entries over time
    for (let i = 0; i < 15; i++) {
      await store.decide(key, spec, 1, 1000 + i * 10);
    }

    // Card should be bounded by maxEntries (10)
    const card = await redisClient.zcard(key);
    expect(card).toBeLessThanOrEqual(10);

    await store.close();
  });

  it('F35: Micro-batching of concurrent peeks via PipelineBatcher', async () => {
    let batchCallCount = 0;
    const batcher = new PipelineBatcher(async (requests) => {
      batchCallCount++;
      return requests.map((r) => ({
        allowed: true,
        limit: 100,
        remaining: 99,
        resetMs: 1000,
        retryAfterMs: 0,
        policyId: r.spec.type,
        reason: 'ok',
        cost: r.cost,
      }));
    }, 10, 10);

    const spec: AlgorithmSpec = { type: 'fixed_window', limit: 100, windowMs: 1000 };

    // Concurrently trigger 5 peeks
    const results = await Promise.all([
      batcher.schedule({ key: 'k1', spec, nowMs: 1000, cost: 1 }),
      batcher.schedule({ key: 'k2', spec, nowMs: 1000, cost: 1 }),
      batcher.schedule({ key: 'k3', spec, nowMs: 1000, cost: 1 }),
      batcher.schedule({ key: 'k4', spec, nowMs: 1000, cost: 1 }),
      batcher.schedule({ key: 'k5', spec, nowMs: 1000, cost: 1 }),
    ]);

    expect(results.length).toBe(5);
    expect(batchCallCount).toBe(1); // All 5 coalesced into a single pipeline batch
  });

  it('F38: Replica read offloading for peek operations', async () => {
    const replicaMock = new RedisClass({ host: '127.0.0.1', port: 6379 });
    const store = new RedisLimiterStore({
      host: '127.0.0.1',
      port: 6379,
      replicaClient: replicaMock,
    });

    const spec: AlgorithmSpec = { type: 'fixed_window', limit: 50, windowMs: 1000 };
    const peekDecision = await store.peek('replica_test_key', spec, 1000);
    expect(peekDecision.allowed).toBe(true);

    await store.close();
  });

  it('F40: Sharded counter key allocation across N buckets', () => {
    const sharded = new ShardedCounterKeyer(4);
    const key = 'tenant:hot_subject:policy';
    const shardKey1 = sharded.getShardKey(key, 'salt-1');
    const shardKey2 = sharded.getShardKey(key, 'salt-2');

    expect(shardKey1).toMatch(/shard_[0-3]$/);
    expect(shardKey2).toMatch(/shard_[0-3]$/);
    expect(sharded.getAllShardKeys(key).length).toBe(4);
  });

  it('F41: Hot-key local shielding via Top-K sketch and local token leases', async () => {
    const shield = new HotKeyShield({ hotThreshold: 5, maxLeaseBatch: 10, leaseTTLMs: 2000 });
    const key = 'hot_client_key';

    // 1. Initial requests track frequency
    for (let i = 0; i < 4; i++) {
      expect(shield.recordAccess(key)).toBe(false);
    }
    // 5th request triggers hot threshold
    expect(shield.recordAccess(key)).toBe(true);

    // 2. Grant lease
    shield.grantLease(key, 10, {
      allowed: true,
      limit: 100,
      remaining: 90,
      resetMs: 5000,
      retryAfterMs: 0,
      policyId: 'token_bucket',
      reason: 'ok',
      cost: 1,
    }, 1000);

    // 3. Consume from local lease without hitting remote store
    const localDecision = shield.tryConsumeLocalLease(key, 1, 1050);
    expect(localDecision).not.toBeNull();
    expect(localDecision?.allowed).toBe(true);
    expect(localDecision?.reason).toBe('ok_local_shield');
  });

  it('F42: Memory eviction policy inspection guards', async () => {
    const store = new RedisLimiterStore({ host: '127.0.0.1', port: 6379 });
    const policy = await store.checkEvictionPolicy(true);
    expect(typeof policy).toBe('string');
    await store.close();
  });

  it('F43: AbortSignal cancellation propagation', async () => {
    const store = new RedisLimiterStore({ host: '127.0.0.1', port: 6379 });
    const controller = new AbortController();
    controller.abort();

    const spec: AlgorithmSpec = { type: 'token_bucket', capacity: 10, refillRate: 1 };
    await expect(store.decide('abort_key', spec, 1, 1000, controller.signal)).rejects.toThrow(/aborted/);

    await store.close();
  });

  it('F44: Standalone fallback mode (degrade_local) under simulated Redis outage', async () => {
    // Connect store to the FaultInjectingProxy
    const store = new RedisLimiterStore({
      host: '127.0.0.1',
      port: proxyPort,
      timeoutMs: 500,
      maxRetriesPerRequest: 1,
    });
    await store.ping();

    const spec: AlgorithmSpec = { type: 'token_bucket', capacity: 10, refillRate: 1 };

    // Normal operation through proxy
    const dNormal = await store.decide('proxy_key', spec, 1, 1000);
    expect(dNormal.allowed).toBe(true);
    expect(store.mode).toBe('normal');

    // Inject partition / blackhole fault
    faultProxy.setFault({ reset: true, partition: true, blackhole: true });

    // Store must gracefully fallback to degrade_local without crashing or dropping
    const dFallback = await store.decide('proxy_key', spec, 1, 1000);
    expect(dFallback.allowed).toBe(true);
    expect(store.mode).toBe('degraded_local');
    expect(store.fallbackCount).toBeGreaterThan(0);

    // Clear fault and recover
    faultProxy.clearFaults();
    await store.close();
  });

  it('F45: Script pre-warming and connection preload', async () => {
    const store = new RedisLimiterStore({ host: '127.0.0.1', port: 6379 });
    await expect(store.preloadScripts()).resolves.not.toThrow();
    await store.close();
  });
});
