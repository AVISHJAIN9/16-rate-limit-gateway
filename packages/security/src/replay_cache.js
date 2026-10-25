import { defaultClock } from '@rlgw/core';
export class ReplayNonceStore {
    windowMs;
    maxEntries;
    nonces = new Map(); // key -> expiresAtMs
    constructor(windowMs = 300_000, // 5 min
    maxEntries = 50_000) {
        this.windowMs = windowMs;
        this.maxEntries = maxEntries;
    }
    checkAndStore(key, nonce, timestampMs, nowMs = defaultClock.nowMs()) {
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
    clear() {
        this.nonces.clear();
    }
}
