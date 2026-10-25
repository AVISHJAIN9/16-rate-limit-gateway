import type { FixedWindowParams, Decision } from '../types.js';

export interface FixedWindowState {
  count: number;
  windowStartMs: number;
}

export class FixedWindowKernel {
  static step(
    state: FixedWindowState,
    params: FixedWindowParams,
    cost: number,
    nowMs: number,
    peekOnly = false
  ): { nextState: FixedWindowState; decision: Decision } {
    const { limit, windowMs } = params;
    const currentWindowStartMs = Math.floor(nowMs / windowMs) * windowMs;
    const resetMs = currentWindowStartMs + windowMs;

    let count = state.count;
    if (state.windowStartMs !== currentWindowStartMs) {
      count = 0;
    }

    if (count + cost <= limit) {
      const nextCount = count + (peekOnly ? 0 : cost);
      return {
        nextState: {
          count: nextCount,
          windowStartMs: currentWindowStartMs
        },
        decision: {
          allowed: true,
          limit,
          remaining: Math.max(0, limit - nextCount),
          resetMs,
          retryAfterMs: 0,
          policyId: 'fixed_window',
          reason: 'ok',
          cost
        }
      };
    }

    const retryAfterMs = Math.max(0, resetMs - nowMs);
    return {
      nextState: {
        count,
        windowStartMs: currentWindowStartMs
      },
      decision: {
        allowed: false,
        limit,
        remaining: Math.max(0, limit - count),
        resetMs,
        retryAfterMs,
        policyId: 'fixed_window',
        reason: 'limit_exceeded',
        cost
      }
    };
  }

  static refund(
    state: FixedWindowState,
    _params: FixedWindowParams,
    cost: number
  ): FixedWindowState {
    return {
      ...state,
      count: Math.max(0, state.count - cost)
    };
  }
}
