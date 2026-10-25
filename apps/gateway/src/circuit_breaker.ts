import { defaultClock, type Clock } from '@rlgw/core';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  failureThresholdRatio?: number; // e.g. 0.5 (50% failures)
  minimumRequests?: number;       // e.g. 10 requests minimum before tripping
  openDurationMs?: number;        // time in open state before transitioning to half_open
  halfOpenProbes?: number;        // allowed probes in half_open before closing or re-opening
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private consecutiveFailures = 0;
  private stateChangedAtMs = 0;
  private halfOpenProbesLeft = 0;

  private readonly failureThresholdRatio: number;
  private readonly minimumRequests: number;
  private readonly openDurationMs: number;
  private readonly halfOpenProbes: number;
  private readonly clock: Clock;

  constructor(
    public readonly name: string,
    config: CircuitBreakerConfig = {},
    clock: Clock = defaultClock
  ) {
    this.failureThresholdRatio = config.failureThresholdRatio ?? 0.5;
    this.minimumRequests = config.minimumRequests ?? 10;
    this.openDurationMs = config.openDurationMs ?? 10000;
    this.halfOpenProbes = config.halfOpenProbes ?? 3;
    this.clock = clock;
    this.stateChangedAtMs = this.clock.nowMs();
  }

  getState(nowMs = this.clock.nowMs()): BreakerState {
    if (this.state === 'open') {
      if (nowMs - this.stateChangedAtMs >= this.openDurationMs) {
        this.transitionTo('half_open', nowMs);
      }
    }
    return this.state;
  }

  canExecute(nowMs = this.clock.nowMs()): boolean {
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

  recordSuccess(nowMs = this.clock.nowMs()): void {
    if (this.state === 'half_open') {
      this.transitionTo('closed', nowMs);
      return;
    }

    this.consecutiveFailures = 0;
    this.successCount++;
    this.trimWindow();
  }

  recordFailure(nowMs = this.clock.nowMs()): void {
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

  private transitionTo(newState: BreakerState, nowMs: number): void {
    this.state = newState;
    this.stateChangedAtMs = nowMs;
    this.failureCount = 0;
    this.successCount = 0;

    if (newState === 'half_open') {
      this.halfOpenProbesLeft = this.halfOpenProbes;
    }
  }

  private trimWindow(): void {
    const total = this.successCount + this.failureCount;
    if (total > 100) {
      // Decay window
      this.successCount = Math.floor(this.successCount / 2);
      this.failureCount = Math.floor(this.failureCount / 2);
    }
  }

  getStatus(): { state: BreakerState; failureCount: number; successCount: number; consecutiveFailures: number } {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      successCount: this.successCount,
      consecutiveFailures: this.consecutiveFailures
    };
  }
}
