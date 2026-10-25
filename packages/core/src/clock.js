/**
 * SystemClock uses the real system time and monotonic hrtime.
 * NOTE: Per Global Rule 0, this is the only module in the system where Date.now() is called.
 */
export class SystemClock {
    nowMs() {
        return Date.now();
    }
    now() {
        return Date.now() / 1000;
    }
    monotonicNs() {
        return process.hrtime.bigint();
    }
}
export const defaultClock = new SystemClock();
/**
 * FakeClock provides deterministically controlled time for tests and simulations.
 */
export class FakeClock {
    currentMs;
    currentNs;
    constructor(initialMs = 0) {
        this.currentMs = initialMs;
        this.currentNs = BigInt(initialMs) * 1000000n;
    }
    nowMs() {
        return this.currentMs;
    }
    now() {
        return this.currentMs / 1000;
    }
    monotonicNs() {
        return this.currentNs;
    }
    set(ms) {
        this.currentMs = ms;
        this.currentNs = BigInt(Math.max(0, Math.floor(ms))) * 1000000n;
    }
    advance(ms) {
        this.set(this.currentMs + ms);
    }
    jumpBackward(ms) {
        this.set(this.currentMs - ms);
    }
}
/**
 * SkewedClock simulates a clock offset or drift against an underlying clock.
 */
export class SkewedClock {
    inner;
    skewOffsetMs;
    constructor(inner, skewOffsetMs = 0) {
        this.inner = inner;
        this.skewOffsetMs = skewOffsetMs;
    }
    nowMs() {
        return this.inner.nowMs() + this.skewOffsetMs;
    }
    now() {
        return this.nowMs() / 1000;
    }
    monotonicNs() {
        return this.inner.monotonicNs() + BigInt(this.skewOffsetMs) * 1000000n;
    }
    setOffset(skewMs) {
        this.skewOffsetMs = skewMs;
    }
}
export { FakeClock as ManualClock };
