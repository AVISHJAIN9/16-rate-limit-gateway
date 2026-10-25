import type { SlidingWindowCounterParams, Decision } from '../types.js';

export interface SlidingWindowCounterState {
  prevCount: number;
  currCount: number;
  currWindowStartMs: number;
}

export class SlidingWindowCounterKernel {
  static step(
    state: SlidingWindowCounterState,
    params: SlidingWindowCounterParams,
    cost: number,
    nowMs: number,
    peekOnly = false
  ): { nextState: SlidingWindowCounterState; decision: Decision } {
    const { limit, windowMs } = params;
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;

    let prevCount = state.prevCount;
    let currCount = state.currCount;
    let currWindowStartMs = state.currWindowStartMs;

    if (currWindowStartMs === windowStart) {
      // same window
    } else if (currWindowStartMs === windowStart - windowMs) {
      // exactly one window advanced
      prevCount = currCount;
      currCount = 0;
      currWindowStartMs = windowStart;
    } else {
      // more than one window advanced
      prevCount = 0;
      currCount = 0;
      currWindowStartMs = windowStart;
    }

    const elapsedInWindow = Math.max(0, nowMs - windowStart);
    const weight = Math.min(1, Math.max(0, elapsedInWindow / windowMs));
    const estimatedCount = prevCount * (1 - weight) + currCount;

    const resetMs = windowStart + windowMs;

    if (estimatedCount + cost <= limit) {
      const nextCurrCount = currCount + (peekOnly ? 0 : cost);
      return {
        nextState: {
          prevCount,
          currCount: nextCurrCount,
          currWindowStartMs
        },
        decision: {
          allowed: true,
          limit,
          remaining: Math.max(0, Math.floor(limit - (estimatedCount + (peekOnly ? 0 : cost)))),
          resetMs,
          retryAfterMs: 0,
          policyId: 'sliding_window_counter',
          reason: 'ok',
          cost
        }
      };
    }

    // Estimated retry-after based on linear decay of prevCount or next window boundary
    const retryAfterMs = Math.max(0, resetMs - nowMs);

    return {
      nextState: {
        prevCount,
        currCount,
        currWindowStartMs
      },
      decision: {
        allowed: false,
        limit,
        remaining: Math.max(0, Math.floor(limit - estimatedCount)),
        resetMs,
        retryAfterMs,
        policyId: 'sliding_window_counter',
        reason: 'limit_exceeded',
        cost
      }
    };
  }

  static refund(
    state: SlidingWindowCounterState,
    _params: SlidingWindowCounterParams,
    cost: number
  ): SlidingWindowCounterState {
    return {
      ...state,
      currCount: Math.max(0, state.currCount - cost)
    };
  }
}
