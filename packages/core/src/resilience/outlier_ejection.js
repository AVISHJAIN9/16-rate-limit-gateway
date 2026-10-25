import { defaultClock } from '../clock.js';
export class OutlierEjector {
    consecutive5xxThreshold;
    baseEjectionDurationMs;
    maxEjectionDurationMs;
    maxEjectionPercent;
    targets = new Map();
    constructor(consecutive5xxThreshold = 5, baseEjectionDurationMs = 30_000, maxEjectionDurationMs = 300_000, maxEjectionPercent = 0.5) {
        this.consecutive5xxThreshold = consecutive5xxThreshold;
        this.baseEjectionDurationMs = baseEjectionDurationMs;
        this.maxEjectionDurationMs = maxEjectionDurationMs;
        this.maxEjectionPercent = maxEjectionPercent;
    }
    recordResponse(target, statusCode, nowMs = defaultClock.nowMs()) {
        let state = this.targets.get(target);
        if (!state) {
            state = {
                consecutive5xx: 0,
                totalRequests: 0,
                failedRequests: 0,
                ejectionCount: 0,
            };
            this.targets.set(target, state);
        }
        state.totalRequests++;
        if (statusCode >= 500 && statusCode < 600) {
            state.failedRequests++;
            state.consecutive5xx++;
            if (state.consecutive5xx >= this.consecutive5xxThreshold && !this.isEjected(target, nowMs)) {
                // Enforce maxEjectionPercent
                const currentlyEjected = Array.from(this.targets.keys()).filter((t) => this.isEjected(t, nowMs)).length;
                if (currentlyEjected / this.targets.size < this.maxEjectionPercent) {
                    state.ejectionCount++;
                    const duration = Math.min(this.maxEjectionDurationMs, this.baseEjectionDurationMs * Math.pow(2, state.ejectionCount - 1));
                    state.ejectedUntilMs = nowMs + duration;
                }
            }
        }
        else {
            state.consecutive5xx = 0;
        }
    }
    isEjected(target, nowMs = defaultClock.nowMs()) {
        const state = this.targets.get(target);
        if (!state || !state.ejectedUntilMs)
            return false;
        if (nowMs >= state.ejectedUntilMs) {
            state.ejectedUntilMs = undefined;
            return false; // Ejection expired
        }
        return true;
    }
    getActiveTargets(allTargets, nowMs = defaultClock.nowMs()) {
        const healthy = allTargets.filter((t) => !this.isEjected(t, nowMs));
        return healthy.length > 0 ? healthy : allTargets; // Fallback: never return empty
    }
}
