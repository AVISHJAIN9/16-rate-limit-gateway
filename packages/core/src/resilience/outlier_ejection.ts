import { defaultClock } from '../clock.js';

export interface OutlierTargetState {
  consecutive5xx: number;
  totalRequests: number;
  failedRequests: number;
  ejectedUntilMs?: number;
  ejectionCount: number;
}

export class OutlierEjector {
  private targets = new Map<string, OutlierTargetState>();

  constructor(
    private readonly consecutive5xxThreshold: number = 5,
    private readonly baseEjectionDurationMs: number = 30_000,
    private readonly maxEjectionDurationMs: number = 300_000,
    private readonly maxEjectionPercent: number = 0.5
  ) {}

  recordResponse(target: string, statusCode: number, nowMs: number = defaultClock.nowMs()): void {
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
          const duration = Math.min(
            this.maxEjectionDurationMs,
            this.baseEjectionDurationMs * Math.pow(2, state.ejectionCount - 1)
          );
          state.ejectedUntilMs = nowMs + duration;
        }
      }
    } else {
      state.consecutive5xx = 0;
    }
  }

  isEjected(target: string, nowMs: number = defaultClock.nowMs()): boolean {
    const state = this.targets.get(target);
    if (!state || !state.ejectedUntilMs) return false;
    if (nowMs >= state.ejectedUntilMs) {
      state.ejectedUntilMs = undefined;
      return false; // Ejection expired
    }
    return true;
  }

  getActiveTargets(allTargets: string[], nowMs: number = defaultClock.nowMs()): string[] {
    const healthy = allTargets.filter((t) => !this.isEjected(t, nowMs));
    return healthy.length > 0 ? healthy : allTargets; // Fallback: never return empty
  }
}
