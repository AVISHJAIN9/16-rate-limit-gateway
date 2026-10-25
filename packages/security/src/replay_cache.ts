import { defaultClock } from '@rlgw/core';

export class ReplayNonceStore {
  private nonces = new Map<string, number>(); // key -> expiresAtMs

  constructor(
    private readonly windowMs: number = 300_000, // 5 min
    private readonly maxEntries: number = 50_000
  ) {}

  checkAndStore(key: string, nonce: string, timestampMs: number, nowMs: number = defaultClock.nowMs()): boolean {
    // 1. Check timestamp skew
    if (Math.abs(nowMs - timestampMs) > this.windowMs) {
      return false; // Timestamp outside replay window
    }

    const nonceKey = `${key}:${nonce}`;

    // 2. Cleanup expired entries periodically if nearing capacity
    if (this.nonces.size >= this.maxEntries) {
      for (const [k, exp] of this.nonces.entries()) {
        if (nowMs >= exp) {
          this.nonces.delete(k);
        }
      }
    }

    // 3. Check duplicate
    if (this.nonces.has(nonceKey)) {
      return false; // Replay detected!
    }

    this.nonces.set(nonceKey, nowMs + this.windowMs);
    return true;
  }

  clear(): void {
    this.nonces.clear();
  }
}
