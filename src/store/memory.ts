import { type Clock, defaultClock } from '../time/clock.js';
import type { CounterEntry, CounterStore } from './types.js';

interface MemoryState {
  count: number;
  expiresAt?: number;
}

export class MemoryStore implements CounterStore {
  private readonly counters = new Map<string, MemoryState>();
  private readonly clock: Clock;

  constructor(clock: Clock = defaultClock) {
    this.clock = clock;
  }

  async incrBy(key: string, delta: number, ttlMs = 0): Promise<number> {
    if (!Number.isFinite(delta)) {
      throw new Error('delta must be finite');
    }

    const nowMs = this.clock.nowMs();
    const existing = this.counters.get(key);
    const active = existing && (existing.expiresAt == null || existing.expiresAt > nowMs) ? existing.count : 0;
    const nextValue = active + delta;

    this.counters.set(key, {
      count: nextValue,
      expiresAt: ttlMs > 0 ? nowMs + ttlMs : undefined
    });

    return nextValue;
  }

  async increment(key: string, cost: number, nowMs: number): Promise<CounterEntry> {
    const previous = this.counters.get(key) ?? { count: 0, expiresAt: undefined };
    const nextCount = previous.count + cost;

    const entry: CounterEntry = {
      count: nextCount,
      windowStartMs: nowMs,
      resetMs: nowMs + 1000
    };

    this.counters.set(key, { count: nextCount, expiresAt: undefined });
    return entry;
  }

  async get(key: string, nowMs?: number): Promise<CounterEntry | number | undefined> {
    const current = this.counters.get(key);
    if (!current) {
      return undefined;
    }

    const effectiveNow = nowMs ?? this.clock.nowMs();
    if (current.expiresAt != null && current.expiresAt <= effectiveNow) {
      this.counters.delete(key);
      return undefined;
    }

    if (nowMs !== undefined) {
      return {
        count: current.count,
        windowStartMs: effectiveNow,
        resetMs: effectiveNow + 1000
      };
    }

    return current.count;
  }

  async expire(key: string, ttlMs: number): Promise<boolean> {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error('ttlMs must be a non-negative number');
    }

    const current = this.counters.get(key);
    if (!current) {
      return false;
    }

    current.expiresAt = this.clock.nowMs() + ttlMs;
    return true;
  }

  async delete(key: string): Promise<void> {
    this.counters.delete(key);
  }
}
