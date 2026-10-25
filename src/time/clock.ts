export interface Clock {
  nowMs(): number;
  monotonicNs(): bigint;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }

  monotonicNs(): bigint {
    return process.hrtime.bigint();
  }
}

export const defaultClock: Clock = new SystemClock();

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

  monotonicNs(): bigint {
    return this.currentNs;
  }

  set(ms: number): void {
    this.currentMs = ms;
    this.currentNs = BigInt(ms) * 1_000_000n;
  }

  advance(ms: number): void {
    this.set(this.currentMs + ms);
  }

  jumpBackward(ms: number): void {
    this.set(this.currentMs - ms);
  }
}
