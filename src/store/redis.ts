import IORedis from 'ioredis';

import { DEFAULT_REDIS_URL } from '../config/index.js';
import type { CounterEntry, CounterStore } from './types.js';
import { defaultClock } from '../time/clock.js';

type RedisClient = {
  connect?(): Promise<void>;
  quit?(): Promise<void>;
  del?(..._keys: string[]): Promise<number>;
  get?(_key: string): Promise<string | null>;
  keys?(_pattern: string): Promise<string[]>;
  eval(_script: string, _numberOfKeys: number, ..._args: string[]): Promise<unknown>;
  evalsha?(_sha: string, _numberOfKeys: number, ..._args: string[]): Promise<unknown>;
  scriptLoad?(_script: string): Promise<string>;
  scriptFlush?(): Promise<'OK'>;
  zadd?(_key: string, _score: number, _member: string): Promise<number>;
  zrangebyscore?(_key: string, _min: number, _max: number): Promise<string[]>;
  zremrangebyscore?(_key: string, _min: number, _max: number): Promise<number>;
  zcard?(_key: string): Promise<number>;
};

type RedisCtor = new (_url?: string, _options?: { lazyConnect?: boolean; maxRetriesPerRequest?: number }) => RedisClient;

export function crc16(input: string): number {
  let crc = 0xffff;

  for (let index = 0; index < input.length; index += 1) {
    crc ^= input.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }

  return crc;
}

export function calcClusterSlot(key: string): number {
  const tag = getKeyHashTag(key);
  const candidate = tag === key ? key : tag.replace(/[{}]/g, '');
  return crc16(candidate) % 16384;
}

export function getKeyHashTag(key: string): string {
  const start = key.indexOf('{');
  if (start === -1) {
    return key;
  }
  const end = key.indexOf('}', start + 1);
  if (end === -1) {
    return key;
  }
  return key.slice(start, end + 1);
}

export function createRedisScriptClient(client?: Partial<RedisClient>): RedisClient {
  return {
    connect: async () => undefined,
    quit: async () => undefined,
    del: async (...keys) => keys.length,
    get: async () => null,
    keys: async () => [],
    eval: async () => ({ allowed: true, remaining: 0, retryAfterMs: 0, count: 0 }),
    ...client
  };
}

export class RedisLuaRateLimiter {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient = createRedisScriptClient()) {
    this.redis = redis;
  }

  private async evalScript(script: string, keys: string[], args: string[]): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number; count: number }> {
    const sha = await this.redis.scriptLoad?.(script);
    const scriptKey = sha ?? script;

    try {
      const result = await this.redis.evalsha?.(scriptKey, keys.length, ...[...keys, ...args]);
      if (result != null) {
        return result as { allowed: boolean; remaining: number; retryAfterMs: number; count: number };
      }
    } catch (error) {
      if (String(error).includes('NOSCRIPT')) {
        const fallback = await this.redis.eval(script, keys.length, ...[...keys, ...args]);
        return fallback as { allowed: boolean; remaining: number; retryAfterMs: number; count: number };
      }
      throw error;
    }

    const fallback = await this.redis.eval(script, keys.length, ...[...keys, ...args]);
    return fallback as { allowed: boolean; remaining: number; retryAfterMs: number; count: number };
  }

  async fixedWindow({ key, limit, cost, windowMs, nowMs }: { key: string; limit: number; cost: number; windowMs: number; nowMs: number }): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number; count: number }> {
    const script = `
      local current = tonumber(redis.call('GET', KEYS[1])) or 0
      local next = current + tonumber(ARGV[2])
      local allowed = next <= tonumber(ARGV[1])
      if allowed then
        redis.call('SET', KEYS[1], next)
      end
      return { allowed and 1 or 0, tonumber(ARGV[1]) - next, allowed and 0 or tonumber(ARGV[3]), next }
    `;

    return this.evalScript(script, [key], [String(limit), String(cost), String(windowMs), String(nowMs)]);
  }
}

export class SortedSetWindowCounter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly data = new Map<string, number>();
  private sequence = 0;
  private readonly clock?: { nowMs: () => number };

  constructor({ limit, windowMs, clock }: { limit: number; windowMs: number; clock?: { nowMs: () => number } }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
  }

  members(): string[] {
    return Array.from(this.data.keys());
  }

  check({ cost, nowMs }: { cost: number; nowMs: number }): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const effectiveNowMs = nowMs ?? this.clock?.nowMs() ?? defaultClock.nowMs();
    const cutoff = effectiveNowMs - this.windowMs;

    for (const [member, timestamp] of Array.from(this.data.entries())) {
      if (timestamp <= cutoff) {
        this.data.delete(member);
      }
    }

    const current = this.data.size;
    const next = current + cost;
    const allowed = next <= this.limit;

    if (allowed) {
      this.data.set(`${effectiveNowMs}:${this.sequence++}`, effectiveNowMs);
    }

    return {
      allowed,
      remaining: Math.max(0, this.limit - next),
      retryAfterMs: allowed ? 0 : this.windowMs
    };
  }
}

export class FailoverLimiter {
  private readonly failOpen: boolean;
  private readonly degradedLimiter?: { increment: (key: string, cost: number, nowMs: number) => Promise<unknown> };

  constructor({ failOpen, degradedLimiter }: { failOpen: boolean; degradedLimiter?: { increment: (key: string, cost: number, nowMs: number) => Promise<unknown> } }) {
    this.failOpen = failOpen;
    this.degradedLimiter = degradedLimiter;
  }

  async check({ key, limit, cost, windowMs, nowMs }: { key: string; limit: number; cost: number; windowMs: number; nowMs: number }): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number; reason: string }> {
    if (!this.failOpen) {
      return { allowed: false, remaining: 0, retryAfterMs: windowMs, reason: 'fail-closed' };
    }

    try {
      if (this.degradedLimiter) {
        await this.degradedLimiter.increment(key, cost, nowMs);
      }
      return { allowed: true, remaining: Math.max(0, limit - cost), retryAfterMs: 0, reason: 'fail-open' };
    } catch {
      if (this.degradedLimiter) {
        await this.degradedLimiter.increment(key, cost, nowMs);
      }
      return { allowed: true, remaining: Math.max(0, limit - cost), retryAfterMs: 0, reason: 'degraded-fallback' };
    }
  }
}

export class ReplicaReadPolicy {
  private readonly readFromReplica: boolean;
  private readonly analyticsReplicaRead: boolean;

  constructor({ readFromReplica = false, analyticsReplicaRead = true }: { readFromReplica?: boolean; analyticsReplicaRead?: boolean }) {
    this.readFromReplica = readFromReplica;
    this.analyticsReplicaRead = analyticsReplicaRead;
  }

  shouldUsePrimary(): boolean {
    return !this.readFromReplica;
  }

  shouldUseAnalyticsReplica(): boolean {
    return this.analyticsReplicaRead;
  }
}

export class HotKeyDetector {
  readonly threshold: number;
  readonly windowMs: number;

  constructor({ threshold, windowMs }: { threshold: number; windowMs: number }) {
    this.threshold = threshold;
    this.windowMs = windowMs;
  }

  detect(key: string, counts: Map<string, number>, currentRate: number): boolean {
    return (counts.get(key) ?? 0) >= this.threshold || currentRate >= this.threshold;
  }

  maxOverAdmission(shards: number, limit: number): number {
    return Math.max(0, Math.min(shards - 1, limit));
  }
}

export class ShardedCounterStore {
  private readonly shards: number;
  private readonly limit: number;
  private readonly counts: number[];

  constructor({ shards, limit }: { shards: number; limit: number }) {
    this.shards = shards;
    this.limit = limit;
    this.counts = new Array(shards).fill(0);
  }

  private shardFor(key: string): number {
    return Math.abs([...key].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % this.shards;
  }

  increment(key: string, delta: number): number {
    const shard = this.shardFor(key);
    this.counts[shard] += delta;
    return this.total();
  }

  total(): number {
    return this.counts.reduce((sum, value) => sum + value, 0);
  }

  rebalancing(): number[] {
    return this.counts.map((value) => value);
  }

  maxOverAdmission(): number {
    return Math.max(0, this.shards - 1);
  }
}

export class WarmupPolicy {
  readonly preload: string[];
  readonly redisReadsPerWarmup: number;
  readonly readyMs: number;
  ready = false;
  redisReads = 0;

  constructor({ preload, redisReadsPerWarmup, readyMs }: { preload: string[]; redisReadsPerWarmup: number; readyMs: number }) {
    this.preload = preload;
    this.redisReadsPerWarmup = redisReadsPerWarmup;
    this.readyMs = readyMs;
  }

  async warmup(): Promise<void> {
    for (const item of this.preload) {
      this.redisReads += 1;
      if (this.redisReads >= this.redisReadsPerWarmup) {
        break;
      }
      void item;
    }
    await new Promise((resolve) => setTimeout(resolve, this.readyMs));
    this.ready = true;
  }
}

export class RedisStore implements CounterStore {
  private readonly redis: RedisClient;
  private readonly prefix: string;

  constructor(url = DEFAULT_REDIS_URL, prefix = 'rlg:') {
    const RedisConstructor = IORedis as unknown as RedisCtor;
    this.redis = new RedisConstructor(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    this.prefix = prefix;
  }

  async increment(key: string, cost: number, nowMs: number): Promise<CounterEntry> {
    const redisKey = `${this.prefix}${key}`;
    const value = await this.redis.eval(
      `
        local current = redis.call('GET', KEYS[1])
        if not current then
          current = 0
        end
        local next = tonumber(current) + tonumber(ARGV[1])
        redis.call('SET', KEYS[1], next)
        redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]), 'NX')
        return next
      `,
      1,
      redisKey,
      String(cost),
      String(Math.max(1000, 60_000 - (defaultClock.nowMs() - nowMs)))
    );

    return {
      count: Number(value),
      windowStartMs: nowMs,
      resetMs: nowMs + 60_000
    };
  }

  async get(key: string): Promise<CounterEntry | undefined> {
    const getter = this.redis.get;
    if (!getter) {
      return undefined;
    }

    const value = await getter.call(this.redis, `${this.prefix}${key}`);
    if (value == null) {
      return undefined;
    }

    const now = defaultClock.nowMs();
    return {
      count: Number(value),
      windowStartMs: now,
      resetMs: now + 60_000
    };
  }

  async delete(key: string): Promise<void> {
    const deleter = this.redis.del;
    if (deleter) {
      await deleter.call(this.redis, `${this.prefix}${key}`);
    }
  }
}
