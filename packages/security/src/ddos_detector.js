import { defaultClock } from '@rlgw/core';
export class DDoSVolumetricDetector {
    subjects = new Map();
    alpha; // EWMA decay factor e.g. 0.2
    zScoreThreshold;
    constructor(alpha = 0.2, zScoreThreshold = 3.5) {
        this.alpha = alpha;
        this.zScoreThreshold = zScoreThreshold;
    }
    recordRequest(subject, rejected = false, nowMs = defaultClock.nowMs()) {
        let state = this.subjects.get(subject);
        if (!state) {
            state = {
                ewmaRate: 1,
                ewmaVariance: 1,
                lastTimestampMs: nowMs,
                totalRequests: 1,
                rejectedRequests: rejected ? 1 : 0,
            };
            this.subjects.set(subject, state);
            return { isSurge: false, zScore: 0 };
        }
        state.totalRequests++;
        if (rejected)
            state.rejectedRequests++;
        const dt = Math.max(0.001, (nowMs - state.lastTimestampMs) / 1000); // in seconds
        const currentRate = 1 / dt;
        state.lastTimestampMs = nowMs;
        // Update EWMA rate and variance
        const diff = currentRate - state.ewmaRate;
        const stdDev = Math.sqrt(state.ewmaVariance) || 1;
        const zScore = Math.abs(diff) / stdDev;
        state.ewmaRate += this.alpha * diff;
        state.ewmaVariance = (1 - this.alpha) * (state.ewmaVariance + this.alpha * diff * diff);
        const isSurge = zScore >= this.zScoreThreshold && state.totalRequests > 10;
        return { isSurge, zScore };
    }
    clear() {
        this.subjects.clear();
    }
}
export { DDoSVolumetricDetector as VolumetricDDoSDetector };
