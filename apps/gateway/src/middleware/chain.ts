import type http from 'node:http';
import crypto from 'node:crypto';
import {
  type Policy,
  type LimiterStore,
  type Clock,
  type Decision,
  type Identity,
  KeyBuilder,
  RouteNormalizer,
  PolicyMatcher,
  CostResolver
} from '@rlgw/core';
import type { CircuitBreaker } from '../circuit_breaker.js';
import type { StreamingReverseProxy } from '../proxy.js';
import type { Recorder, RequestContext } from '@rlgw/core';

export interface GatewayMiddlewareOptions {
  store: LimiterStore;
  matcher: PolicyMatcher;
  keyBuilder: KeyBuilder;
  clock: Clock;
  circuitBreaker?: CircuitBreaker;
  proxy: StreamingReverseProxy;
  recorder?: Recorder;
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
export type Middleware = (next: Handler) => Handler;

export class GatewayMiddlewareChain {
  private readonly store: LimiterStore;
  private readonly matcher: PolicyMatcher;
  private readonly keyBuilder: KeyBuilder;
  private readonly clock: Clock;
  private readonly circuitBreaker?: CircuitBreaker;
  private readonly proxy: StreamingReverseProxy;
  private readonly recorder?: Recorder;

  constructor(options: GatewayMiddlewareOptions) {
    this.store = options.store;
    this.matcher = options.matcher;
    this.keyBuilder = options.keyBuilder;
    this.clock = options.clock;
    this.circuitBreaker = options.circuitBreaker;
    this.proxy = options.proxy;
    this.recorder = options.recorder;
  }

  /**
   * Main entrypoint following the documented middleware order:
   * 1. recovery
   * 2. request-id
   * 3. normalize
   * 4. identity
   * 5. limit (two-phase: peek -> commit -> refund rollback)
   * 6. circuit-breaker
   * 7. proxy
   * 8. response-headers
   */
  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 1. Recovery
    try {
      await this.runPipeline(req, res);
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error', message: err?.message || 'Unexpected failure' }));
      }
    }
  }

  private async runPipeline(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const nowMs = this.clock.nowMs();

    // 2. Request-ID
    let requestId = req.headers['x-request-id'] as string;
    if (!requestId || typeof requestId !== 'string' || requestId.length > 128) {
      requestId = crypto.randomUUID();
    }
    res.setHeader('X-Request-Id', requestId);

    // 3. Normalize path
    const rawPath = req.url || '/';
    let canonicalPath: string;
    try {
      canonicalPath = RouteNormalizer.normalize(rawPath);
    } catch (_err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Request: Invalid path format' }));
      return;
    }

    // 4. Identity derivation
    const clientIp = this.deriveClientIp(req);
    const identity: Identity = {
      tenant: (req.headers['x-tenant-id'] as string) || 'global',
      clientId: (req.headers['x-client-id'] as string) || clientIp,
      apiKeyId: (req.headers['x-api-key'] as string) || undefined,
      ip: clientIp,
      source: 'header'
    };

    const ctx: RequestContext = {
      requestId,
      traceId: (req.headers['x-trace-id'] as string) || (req.headers['traceparent'] as string) || undefined,
      identity,
      path: canonicalPath,
      method: req.method || 'GET',
      headers: req.headers,
      startTimeMs: nowMs,
      clock: this.clock
    };

    // 5. Rate limit evaluation (Two-phase decide)
    const matchingPolicies = this.matcher.matchAll(
      req.method || 'GET',
      canonicalPath,
      req.headers as any,
      identity
    );

    const committed: Array<{ policy: Policy; decision: Decision; key: string; cost: number }> = [];
    if (matchingPolicies.length > 0) {
      // Phase 1: Peek all matching policies
      const peekDecisions: Array<{ policy: Policy; decision: Decision; key: string; cost: number }> = [];

      for (const policy of matchingPolicies) {
        let cost: number;
        try {
          cost = CostResolver.resolve({
            spec: policy.cost,
            headerCost: (req.headers['cost'] as string) || (req.headers['x-rlgw-cost'] as string),
            method: req.method,
            route: canonicalPath
          });
        } catch (costErr: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bad Request: Invalid Cost header', message: costErr?.message }));
          return;
        }

        const key = this.keyBuilder.build(
          policy.tenant,
          identity.clientId,
          policy.id,
          policy.algorithm
        );

        let decision: Decision;
        try {
          decision = await this.store.peek(key, policy.params, nowMs, cost);
        } catch (_storeErr: any) {
          if (policy.failMode === 'fail_open') {
            decision = {
              allowed: true,
              limit: 1000,
              remaining: 1000,
              resetMs: nowMs,
              retryAfterMs: 0,
              policyId: policy.id,
              reason: 'fail_open_store_error',
              cost
            };
          } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Service Unavailable: Rate limiter store error' }));
            return;
          }
        }

        peekDecisions.push({ policy, decision, key, cost });

        // If not allowed, reject immediately without touching counters
        if (!decision.allowed) {
          this.recorder?.onDecision(decision, ctx);
          this.applyRateLimitHeaders(res, decision, policy);
          this.sendRejection(res, policy, decision, requestId);
          return;
        }

        // Check terminal deny
        if (policy.terminalDeny) {
          break;
        }
      }

      // Phase 2: All peek passed -> commit
      let commitFailed = false;

      for (const item of peekDecisions) {
        try {
          const commitDecision = await this.store.commit(item.key, item.policy.params, item.cost, nowMs);
          if (!commitDecision.allowed) {
            // Concurrent race condition tripped limit during commit
            commitFailed = true;
            this.recorder?.onDecision(commitDecision, ctx);
            this.applyRateLimitHeaders(res, commitDecision, item.policy);
            this.sendRejection(res, item.policy, commitDecision, requestId);
            break;
          }
          committed.push({ policy: item.policy, decision: commitDecision, key: item.key, cost: item.cost });
        } catch (_commitErr) {
          commitFailed = true;
          break;
        }
      }

      // Rollback on race failure
      if (commitFailed) {
        for (const item of committed) {
          await this.store.refund(item.key, item.policy.params, item.cost, nowMs);
        }
        return;
      }

      // Attach rate limit headers from the most restrictive policy after commit
      const mostRestrictive = committed.reduce((prev, curr) =>
        curr.decision.remaining < prev.decision.remaining ? curr : prev
      );
      this.recorder?.onDecision(mostRestrictive.decision, ctx);
      this.applyRateLimitHeaders(res, mostRestrictive.decision, mostRestrictive.policy);
    }

    // 6. Circuit Breaker check
    if (this.circuitBreaker && !this.circuitBreaker.canExecute(nowMs)) {
      // Refund committed tokens since breaker dropped request before upstream
      for (const item of committed) {
        await this.store.refund(item.key, item.policy.params, item.cost, nowMs);
      }
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Service Unavailable: Circuit breaker open' }));
      return;
    }

    // 7. Proxy streaming using canonicalPath
    await this.proxy.handleRequest(req, res, clientIp, canonicalPath);
  }

  private deriveClientIp(req: http.IncomingMessage): string {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string') {
      const parts = xff.split(',').map((p) => p.trim());
      if (parts.length > 0 && parts[0]) {
        return parts[0];
      }
    }
    return req.socket.remoteAddress || '127.0.0.1';
  }

  private applyRateLimitHeaders(
    res: http.ServerResponse,
    decision: Decision,
    policy: Policy
  ): void {
    const resetSeconds = Math.ceil(Math.max(0, decision.resetMs - this.clock.nowMs()) / 1000);

    // IETF draft headers
    res.setHeader('RateLimit-Limit', decision.limit.toString());
    res.setHeader('RateLimit-Remaining', decision.remaining.toString());
    res.setHeader('RateLimit-Reset', resetSeconds.toString());
    res.setHeader('RateLimit-Policy', `${policy.id};w=${resetSeconds}`);

    // Legacy X-RateLimit headers
    res.setHeader('X-RateLimit-Limit', decision.limit.toString());
    res.setHeader('X-RateLimit-Remaining', decision.remaining.toString());
    res.setHeader('X-RateLimit-Reset', Math.ceil(decision.resetMs / 1000).toString());

    if (!decision.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      res.setHeader('Retry-After', retryAfterSec.toString());
      res.setHeader('Cache-Control', 'no-store');
    }
  }

  private sendRejection(
    res: http.ServerResponse,
    policy: Policy,
    decision: Decision,
    requestId: string
  ): void {
    const template = policy.rejectionTemplate;
    const status = template?.status || 429;
    const contentType = template?.contentType || 'application/json';

    const retryAfterSec = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));

    let bodyText: string;
    if (template?.body) {
      bodyText = template.body
        .replace(/\{\{retry_after\}\}/g, retryAfterSec.toString())
        .replace(/\{\{limit\}\}/g, decision.limit.toString())
        .replace(/\{\{policy\}\}/g, policy.id)
        .replace(/\{\{request_id\}\}/g, requestId);
    } else if (contentType === 'application/problem+json') {
      bodyText = JSON.stringify({
        type: 'https://tools.ietf.org/html/rfc6585#section-4',
        title: 'Too Many Requests',
        status,
        detail: `Rate limit quota exceeded for policy ${policy.id}. Try again in ${retryAfterSec} seconds.`,
        retryAfter: retryAfterSec,
        requestId
      });
    } else {
      bodyText = JSON.stringify({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${retryAfterSec} seconds.`,
        retryAfter: retryAfterSec,
        policy: policy.id,
        requestId
      });
    }

    res.writeHead(status, {
      'Content-Type': contentType,
      'Retry-After': retryAfterSec.toString(),
      'Cache-Control': 'no-store'
    });
    res.end(bodyText);
  }
}
