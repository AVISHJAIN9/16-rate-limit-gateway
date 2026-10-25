import type { Request, Response, NextFunction } from 'express';
import {
  type LimiterStore,
  type Policy,
  type Clock,
  type Identity,
  KeyBuilder,
  PolicyMatcher,
  RouteNormalizer,
  SystemClock
} from '@rlgw/core';

export interface StandaloneMiddlewareOptions {
  store: LimiterStore;
  policies: Policy[];
  keyBuilder?: KeyBuilder;
  clock?: Clock;
}

export function createRateLimitMiddleware(options: StandaloneMiddlewareOptions) {
  const store = options.store;
  const matcher = new PolicyMatcher(options.policies);
  const keyBuilder = options.keyBuilder ?? new KeyBuilder();
  const clock = options.clock ?? new SystemClock();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const nowMs = clock.nowMs();
    let canonicalPath: string;
    try {
      canonicalPath = RouteNormalizer.normalize(req.path || req.url);
    } catch {
      res.status(400).json({ error: 'Bad Request: Invalid path format' });
      return;
    }

    const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const identity: Identity = {
      tenant: (req.headers['x-tenant-id'] as string) || 'global',
      clientId: (req.headers['x-client-id'] as string) || clientIp,
      ip: clientIp,
      source: 'header'
    };

    const matchingPolicies = matcher.matchAll(req.method, canonicalPath, req.headers as any, identity);

    if (matchingPolicies.length === 0) {
      next();
      return;
    }

    // Two-phase decide: peek first
    for (const policy of matchingPolicies) {
      const key = keyBuilder.build(policy.tenant, identity.clientId, policy.id, policy.algorithm);
      try {
        const decision = await store.decide(key, policy.params, 1, nowMs);
        res.setHeader('RateLimit-Limit', decision.limit);
        res.setHeader('RateLimit-Remaining', decision.remaining);
        res.setHeader('RateLimit-Reset', Math.ceil(Math.max(0, decision.resetMs - nowMs) / 1000));

        if (!decision.allowed) {
          const retryAfterSec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
          res.setHeader('Retry-After', retryAfterSec);
          res.status(429).json({
            error: 'Too Many Requests',
            retryAfter: retryAfterSec,
            policy: policy.id
          });
          return;
        }
      } catch (_err) {
        if (policy.failMode !== 'fail_open') {
          res.status(503).json({ error: 'Rate limiter unavailable' });
          return;
        }
      }
    }

    next();
  };
}
