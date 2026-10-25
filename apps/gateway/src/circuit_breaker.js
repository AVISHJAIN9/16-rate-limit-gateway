import { defaultClock } from '@rlgw/core';
export class CircuitBreaker {
    name;
    state = 'closed';
    failureCount = 0;
    successCount = 0;
    consecutiveFailures = 0;
    stateChangedAtMs = 0;
    halfOpenProbesLeft = 0;
    failureThresholdRatio;
    minimumRequests;
    openDurationMs;
    halfOpenProbes;
    clock;
    constructor(name, config = {}, clock = defaultClock) {
        this.name = name;
        this.failureThresholdRatio = config.failureThresholdRatio ?? 0.5;
        this.minimumRequests = config.minimumRequests ?? 10;
        this.openDurationMs = config.openDurationMs ?? 10000;
        this.halfOpenProbes = config.halfOpenProbes ?? 3;
        this.clock = clock;
        this.stateChangedAtMs = this.clock.nowMs();
    }
    getState(nowMs = this.clock.nowMs()) {
        if (this.state === 'open') {
            if (nowMs - this.stateChangedAtMs >= this.openDurationMs) {
                this.transitionTo('half_open', nowMs);
            }
        }
        return this.state;
    }
    canExecute(nowMs = this.clock.nowMs()) {
        const currentState = this.getState(nowMs);
        if (currentState === 'closed') {
            return true;
        }
        if (currentState === 'half_open') {
            if (this.halfOpenProbesLeft > 0) {
                this.halfOpenProbesLeft--;
                return true;
            }
            return false;
        }
        return false; // open
    }
    recordSuccess(nowMs = this.clock.nowMs()) {
        if (this.state === 'half_open') {
            this.transitionTo('closed', nowMs);
            return;
        }
        this.consecutiveFailures = 0;
        this.successCount++;
        this.trimWindow();
    }
    recordFailure(nowMs = this.clock.nowMs()) {
        this.consecutiveFailures++;
        this.failureCount++;
        if (this.state === 'half_open') {
            this.transitionTo('open', nowMs);
            return;
        }
        const totalRequests = this.successCount + this.failureCount;
        if (totalRequests >= this.minimumRequests) {
            const failureRate = this.failureCount / totalRequests;
            if (failureRate >= this.failureThresholdRatio || this.consecutiveFailures >= 5) {
                this.transitionTo('open', nowMs);
            }
        }
        this.trimWindow();
    }
    transitionTo(newState, nowMs) {
        this.state = newState;
        this.stateChangedAtMs = nowMs;
        this.failureCount = 0;
        this.successCount = 0;
        if (newState === 'half_open') {
            this.halfOpenProbesLeft = this.halfOpenProbes;
        }
    }
    trimWindow() {
        const total = this.successCount + this.failureCount;
        if (total > 100) {
            // Decay window
            this.successCount = Math.floor(this.successCount / 2);
            this.failureCount = Math.floor(this.failureCount / 2);
        }
    }
    getStatus() {
        return {
            state: this.getState(),
            failureCount: this.failureCount,
            successCount: this.successCount,
            consecutiveFailures: this.consecutiveFailures
        };
    }
}
