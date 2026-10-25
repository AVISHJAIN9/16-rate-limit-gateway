export interface Clock {
  nowMs(): number;
  now(): number; // timestamp in seconds (floating or integer)
  monotonicNs(): bigint;
}

/**
 * SystemClock uses the real system time and monotonic hrtime.
 * NOTE: Per Global Rule 0, this is the only module in the system where Date.now() is called.
 */
export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }

  now(): number {
    return Date.now() / 1000;
  }

  monotonicNs(): bigint {
    return process.hrtime.bigint();
  }
}

export const defaultClock: Clock = new SystemClock();

/**
 * FakeClock provides deterministically controlled time for tests and simulations.
 */
export class FakeClock implements Clock {
  private currentMs: number;
  private currentNs: bigint;

  constructor(initialMs = 0) {
    this.currentMs = initialMs;
    this.currentNs = BigInt(initialMs) * 1_000_000n;
  }

  nowMs(): number {
    return this.currentMs;
  }

  now(): number {
    return this.currentMs / 1000;
  }

  monotonicNs(): bigint {
    return this.currentNs;
  }

  set(ms: number): void {
    this.currentMs = ms;
    this.currentNs = BigInt(Math.max(0, Math.floor(ms))) * 1_000_000n;
  }

  advance(ms: number): void {
    this.set(this.currentMs + ms);
  }

  jumpBackward(ms: number): void {
    this.set(this.currentMs - ms);
  }
}

/**
 * SkewedClock simulates a clock offset or drift against an underlying clock.
 */
export class SkewedClock implements Clock {
  constructor(
    private readonly inner: Clock,
    private skewOffsetMs: number = 0
  ) {}

  nowMs(): number {
    return this.inner.nowMs() + this.skewOffsetMs;
  }

  now(): number {
    return this.nowMs() / 1000;
  }

  monotonicNs(): bigint {
    return this.inner.monotonicNs() + BigInt(this.skewOffsetMs) * 1_000_000n;
  }

  setOffset(skewMs: number): void {
    this.skewOffsetMs = skewMs;
  }
}

export { FakeClock as ManualClock };
