import { describe, expect, it } from 'vitest';

import {
  FailoverLimiter,
  HotKeyDetector,
  RedisLuaRateLimiter,
  ReplicaReadPolicy,
  ShardedCounterStore,
  SortedSetWindowCounter,
  WarmupPolicy,
  calcClusterSlot,
  crc16,
  getKeyHashTag
} from '../src/store/redis.js';
import { MemoryStore } from '../src/store/memory.js';
import { FakeClock } from '../src/time/clock.js';

class FakeRedisClient {
  public values = new Map<string, number>();
  public scriptCache = new Map<string, string>();
  public flushed = false;
  public reads = 0;
  public writes = 0;

  async eval(script: string, _numKeys: number, ...args: string[]): Promise<unknown> {
    if (this.flushed) {
      this.flushed = false;
      throw new Error('NOSCRIPT');
    }

    const key = args[0] ?? 'key';
    const limit = Number(args[1] ?? 0);
    const cost = Number(args[2] ?? 1);
    const nowMs = Number(args[3] ?? 0);

    const current = this.values.get(key) ?? 0;
    const next = current + cost;
    const allowed = next <= limit;
    if (allowed) {
      this.values.set(key, next);
      this.writes += 1;
    }
    this.reads += 1;
    return { allowed, remaining: Math.max(0, limit - next), retryAfterMs: allowed ? 0 : 1000, nowMs, count: next };
  }

  async evalsha(sha: string, _numKeys: number, ...args: string[]): Promise<unknown> {
    const script = this.scriptCache.get(sha) ?? '';
    if (!script) {
      throw new Error('NOSCRIPT');
    }
    return this.eval(script, _numKeys, ...args);
  }

  async scriptLoad(script: string): Promise<string> {
    const sha = `sha:${script.length}`;
    this.scriptCache.set(sha, script);
    return sha;
  }

  async flushdb(): Promise<void> {
    this.values.clear();
    this.flushed = true;
  }

  async get(key: string): Promise<string | null> {
    const value = this.values.get(key);
    return value == null ? null : String(value);
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.values.set(key, Number(value));
    this.writes += 1;
    return 'OK';
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    this.values.set(`${key}:${member}`, score);
    this.writes += 1;
    return 1;
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    return Array.from(this.values.entries())
      .filter(([mapKey]) => mapKey.startsWith(`${key}:`))
      .filter(([, score]) => score >= min && score <= max)
      .map(([mapKey]) => mapKey.slice(key.length + 1));
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    let removed = 0;
    for (const [mapKey, score] of Array.from(this.values.entries())) {
      if (mapKey.startsWith(`${key}:`) && score >= min && score <= max) {
        this.values.delete(mapKey);
        removed += 1;
      }
    }
    return removed;
  }

  async zcard(key: string): Promise<number> {
    return Array.from(this.values.keys()).filter((mapKey) => mapKey.startsWith(`${key}:`)).length;
  }
}

describe('batch 06 redis hardening', () => {
  it('33: Redis Lua decisions survive SCRIPT FLUSH and enforce a fixed-window limit', async () => {
    const redis = new FakeRedisClient();
    const limiter = new RedisLuaRateLimiter(redis);

    const decisions = await Promise.all(
      Array.from({ length: 6 }, (_, index) => limiter.fixedWindow({
        key: 'lua:limit',
        limit: 5,
        cost: 1,
        windowMs: 1_000,
        nowMs: index
      }))
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
    expect(decisions[5]?.allowed).toBe(false);

    await redis.flushdb();
    const recovered = await limiter.fixedWindow({ key: 'lua:limit', limit: 5, cost: 1, windowMs: 1_000, nowMs: 6 });
    expect(recovered.allowed).toBe(true);
  });

  it('33: parallel calls never exceed the limit and remain atomic', async () => {
    const redis = new FakeRedisClient();
    const limiter = new RedisLuaRateLimiter(redis);

    const run = Array.from({ length: 1_000 }, (_, index) => limiter.fixedWindow({
      key: `parallel:${index % 10}`,
      limit: 10,
      cost: 1,
      windowMs: 1_000,
      nowMs: index
    }));

    const decisions = await Promise.all(run);
    const admitted = decisions.filter((decision) => decision.allowed).length;
    expect(admitted).toBeLessThanOrEqual(10 * 10);
    expect(decisions.some((decision) => !decision.allowed)).toBe(true);
  });

  it('37: sorted sets are unique, trimmed, bounded, and exact', async () => {
    const counter = new SortedSetWindowCounter({ limit: 2, windowMs: 1000, clock: new FakeClock(0) });

    let decision = counter.check({ cost: 1, nowMs: 11 });
    expect(decision.allowed).toBe(true);
    decision = counter.check({ cost: 1, nowMs: 11 });
    expect(decision.allowed).toBe(true);
    decision = counter.check({ cost: 1, nowMs: 11 });
    expect(decision.allowed).toBe(false);
    expect(counter.members()).toHaveLength(2);

    counter.check({ cost: 1, nowMs: 9 });
    counter.check({ cost: 1, nowMs: 20 });
    expect(counter.members().length).toBeLessThanOrEqual(2);
  });

  it('38: cluster slot and hash tag semantics', () => {
    expect(calcClusterSlot('{tenant:42}:orders')).toBeGreaterThanOrEqual(0);
    expect(calcClusterSlot('{tenant:42}:orders')).toBeLessThan(16384);
    expect(getKeyHashTag('limit:{tenant:42}:orders')).toBe('{tenant:42}');
    expect(getKeyHashTag('route:plain')).toBe('route:plain');
    expect(crc16('123456789')).toBe(0x29b1);
  });

  it('41: fail-open and fail-closed policy handling', async () => {
    const limiter = new FailoverLimiter({
      failOpen: true,
      degradedLimiter: new MemoryStore(new FakeClock(0))
    });

    const allowed = await limiter.check({ key: 'fail-open', limit: 1, cost: 1, windowMs: 1000, nowMs: 0 });
    expect(allowed.allowed).toBe(true);

    const closed = new FailoverLimiter({ failOpen: false, degradedLimiter: new MemoryStore(new FakeClock(0)) });
    const rejected = await closed.check({ key: 'fail-closed', limit: 1, cost: 1, windowMs: 1000, nowMs: 0 });
    expect(rejected.allowed).toBe(false);
  });

  it('42: replica reads are primary-only by default', async () => {
    const policy = new ReplicaReadPolicy({ readFromReplica: false, analyticsReplicaRead: true });
    expect(policy.shouldUsePrimary()).toBe(true);
    expect(policy.shouldUseAnalyticsReplica()).toBe(true);
  });

  it('43: hot keys are detected and bounded', async () => {
    const detector = new HotKeyDetector({ threshold: 10, windowMs: 1000 });
    const counts = new Map<string, number>([['hot:alpha', 11]]);
    expect(detector.detect('hot:alpha', counts, 10)).toBe(true);
    expect(detector.maxOverAdmission(4, 10)).toBe(3);
  });

  it('44: sharded counters bound total admission', async () => {
    const store = new ShardedCounterStore({ shards: 4, limit: 10 });
    for (let i = 0; i < 12; i += 1) {
      store.increment(`k:${i}`, 1);
    }
    expect(store.total()).toBeLessThanOrEqual(10 + 4 - 1);
  });

  it('45: warm-up readiness and no thundering herd are surfaced', async () => {
    const policy = new WarmupPolicy({
      preload: ['alpha', 'beta'],
      redisReadsPerWarmup: 2,
      readyMs: 20
    });

    expect(policy.ready).toBe(false);
    await policy.warmup();
    expect(policy.ready).toBe(true);
    expect(policy.redisReads).toBeLessThanOrEqual(2);
  });
});
