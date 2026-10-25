import type { TokenBucketParams, Decision } from '../types.js';

export interface TokenBucketState {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucketKernel {
  static step(
    state: TokenBucketState,
    params: TokenBucketParams,
    cost: number,
    nowMs: number,
    peekOnly = false
  ): { nextState: TokenBucketState; decision: Decision } {
    const { capacity, refillRate } = params;

    if (cost > capacity) {
      return {
        nextState: { ...state },
        decision: {
          allowed: false,
          limit: capacity,
          remaining: state.tokens,
          resetMs: nowMs,
          retryAfterMs: Number.POSITIVE_INFINITY,
          policyId: 'token_bucket',
          reason: 'cost_exceeds_burst',
          cost,
          burst: capacity
        }
      };
    }

    const elapsedMs = Math.max(0, nowMs - state.lastRefillMs);
    const refillTokens = elapsedMs * (refillRate / 1000);
    const currentTokens = Math.min(capacity, state.tokens + refillTokens);

    if (currentTokens >= cost) {
      const remainingTokens = currentTokens - (peekOnly ? 0 : cost);
      return {
        nextState: {
          tokens: remainingTokens,
          lastRefillMs: nowMs
        },
        decision: {
          allowed: true,
          limit: capacity,
          remaining: Math.max(0, remainingTokens),
          resetMs: nowMs,
          retryAfterMs: 0,
          policyId: 'token_bucket',
          reason: 'ok',
          cost,
          burst: capacity
        }
      };
    }

    const deficit = cost - currentTokens;
    const retryAfterMs = refillRate > 0 ? Math.ceil((deficit / refillRate) * 1000) : Number.POSITIVE_INFINITY;

    return {
      nextState: {
        tokens: currentTokens,
        lastRefillMs: nowMs
      },
      decision: {
        allowed: false,
        limit: capacity,
        remaining: Math.max(0, currentTokens),
        resetMs: nowMs + (Number.isFinite(retryAfterMs) ? retryAfterMs : 0),
        retryAfterMs,
        policyId: 'token_bucket',
        reason: 'limit_exceeded',
        cost,
        burst: capacity
      }
    };
  }

  static refund(
    state: TokenBucketState,
    params: TokenBucketParams,
    cost: number
  ): TokenBucketState {
    return {
      ...state,
      tokens: Math.min(params.capacity, state.tokens + cost)
    };
  }
}
