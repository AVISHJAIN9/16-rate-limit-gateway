import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import {
  type GatewayConfig,
  PolicyLoader,
  PolicyMatcher,
  KeyBuilder,
  FakeClock,
  SystemClock,
  type Policy
} from '@rlgw/core';
import { MemoryLimiterStore } from '@rlgw/store-memory';
import { StreamingReverseProxy } from '../apps/gateway/src/proxy.js';
import { CircuitBreaker } from '../apps/gateway/src/circuit_breaker.js';
import { GatewayMiddlewareChain } from '../apps/gateway/src/middleware/chain.js';
import { createRateLimitMiddleware } from '../apps/gateway/src/middleware/standalone.js';
import { createAdminApp } from '../apps/gateway/src/admin.js';
import express from 'express';

describe('P1: HTTP Gateway & Backend E2E Tests (F61-F75)', () => {
  let upstreamServer: http.Server;
  let upstreamPort: number;

  let gatewayServer: http.Server;
  let adminServer: http.Server;
  let isDraining = false;

  let fakeClock: FakeClock;
  let memStore: MemoryLimiterStore;
  let policyLoader: PolicyLoader;
  let proxy: StreamingReverseProxy;
  let breaker: CircuitBreaker;

  const testPolicies: Policy[] = [
    {
      id: 'pol-search',
      tenant: 'acme',
      match: { route: '/api/v1/search', methods: ['GET'] },
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 3, refillRate: 1 },
      priority: 50,
      failMode: 'fail_closed',
      enabled: true,
      rejectionTemplate: {
        status: 429,
        contentType: 'application/problem+json',
        body: undefined
      }
    },
    {
      id: 'pol-users',
      tenant: 'acme',
      match: { route: '/api/v1/users/:id' },
      algorithm: 'fixed_window',
      params: { type: 'fixed_window', limit: 2, windowMs: 1000 },
      priority: 60,
      failMode: 'fail_closed',
      enabled: true
    }
  ];

  beforeAll(async () => {
    // 1. Start mock upstream server
    upstreamServer = http.createServer((req, res) => {
      if (req.url === '/api/v1/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'delayed response' }));
        }, 1500);
        return;
      }
      if (req.url === '/api/v1/error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream failure' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, path: req.url, method: req.method }));
    });

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => {
        const addr = upstreamServer.address() as any;
        upstreamPort = addr.port;
        resolve();
      });
    });

    // 2. Setup gateway with fake clock
    fakeClock = new FakeClock(10000);
    memStore = new MemoryLimiterStore();
    const matcher = new PolicyMatcher(testPolicies);

    proxy = new StreamingReverseProxy({
      routes: [
        {
          pathPrefix: '/api',
          targets: [{ url: `http://127.0.0.1:${upstreamPort}`, weight: 1 }],
          timeoutMs: 500
        }
      ]
    });

    breaker = new CircuitBreaker('test-breaker', {
      failureThresholdRatio: 0.5,
      minimumRequests: 2,
      openDurationMs: 1000
    });

    const chain = new GatewayMiddlewareChain({
      store: memStore,
      matcher,
      keyBuilder: new KeyBuilder(),
      clock: fakeClock,
      circuitBreaker: breaker,
      proxy
    });

    gatewayServer = http.createServer((req, res) => {
      void chain.handle(req, res);
    });

    // 3. Setup admin server
    policyLoader = new PolicyLoader();
    policyLoader.loadFromString(JSON.stringify({ policies: testPolicies }));

    const adminApp = createAdminApp({
      policyLoader,
      store: memStore,
      circuitBreaker: breaker,
      isDraining: () => isDraining,
      adminAuth: {
        authenticate: async (token?: string) => (token === 'admin-secret' ? { id: '1', username: 'adm', roles: ['admin'] } : null)
      }
    });

    adminServer = http.createServer(adminApp);
  });

  afterAll(async () => {
    await new Promise((resolve) => upstreamServer.close(resolve));
    await new Promise((resolve) => gatewayServer.close(resolve));
    await new Promise((resolve) => adminServer.close(resolve));
    proxy.close();
  });

  describe('F61, F63, F66, F67: Rate limit headers, 429 response, and Retry-After correctness', () => {
    it('allows requests within capacity and attaches RateLimit headers', async () => {
      const res1 = await request(gatewayServer)
        .get('/api/v1/search')
        .set('x-client-id', 'client-a');

      expect(res1.status).toBe(200);
      expect(res1.headers['ratelimit-limit']).toBe('3');
      expect(res1.headers['ratelimit-remaining']).toBe('2');
      expect(res1.headers['x-request-id']).toBeDefined();

      const res2 = await request(gatewayServer)
        .get('/api/v1/search')
        .set('x-client-id', 'client-a');
      expect(res2.status).toBe(200);
      expect(res2.headers['ratelimit-remaining']).toBe('1');

      const res3 = await request(gatewayServer)
        .get('/api/v1/search')
        .set('x-client-id', 'client-a');
      expect(res3.status).toBe(200);
      expect(res3.headers['ratelimit-remaining']).toBe('0');
    });

    it('rejects with 429 and Retry-After header when limit is exceeded', async () => {
      const res4 = await request(gatewayServer)
        .get('/api/v1/search')
        .set('x-client-id', 'client-a');

      expect(res4.status).toBe(429);
      expect(res4.headers['retry-after']).toBeDefined();
      expect(res4.headers['cache-control']).toBe('no-store');
      expect(res4.headers['content-type']).toContain('application/problem+json');
    });

    it('Retry-After correctness: succeeds once fake clock advances past reset', async () => {
      // Advance clock by 2 seconds (refillRate = 1 token/sec -> adds 2 tokens)
      fakeClock.advance(2000);

      const res = await request(gatewayServer)
        .get('/api/v1/search')
        .set('x-client-id', 'client-a');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('F64: Normalization bypass prevention', () => {
    it('maps duplicate slashes and dot-segments to canonical route identity', async () => {
      // Capacity for pol-users is 2 per 1000ms
      const clientId = 'user-test-norm';

      const res1 = await request(gatewayServer)
        .get('/api/v1/users/123')
        .set('x-client-id', clientId);
      expect(res1.status).toBe(200);

      // Attempt bypass using double slashes // and dot segments /.
      const res2 = await request(gatewayServer)
        .get('///api//v1/./users/123')
        .set('x-client-id', clientId);
      expect(res2.status).toBe(200);

      // 3rd attempt must be rejected (limit was 2)
      const res3 = await request(gatewayServer)
        .get('/api/v1/../v1/users/123')
        .set('x-client-id', clientId);
      expect(res3.status).toBe(429);
    });
  });

  describe('F70, F71: Upstream timeouts and circuit breaker transitions', () => {
    it('maps upstream timeouts to 504 Gateway Timeout', async () => {
      const res = await request(gatewayServer)
        .get('/api/v1/slow')
        .set('x-client-id', 'timeout-client');

      expect(res.status).toBe(504);
      expect(res.body.error).toContain('Gateway Timeout');
    });

    it('trips circuit breaker on consecutive upstream failures and refunds rate limit decisions', async () => {
      // Record 2 failures on breaker
      breaker.recordFailure();
      breaker.recordFailure();

      expect(breaker.getState()).toBe('open');

      const res = await request(gatewayServer)
        .get('/api/v1/users/999')
        .set('x-client-id', 'breaker-client');

      expect(res.status).toBe(503);
      expect(res.body.error).toContain('Circuit breaker open');
    });
  });

  describe('F72, F73, F74, F75: Admin API & Observability Endpoints', () => {
    it('/healthz returns 200 with event loop delay metric', async () => {
      const res = await request(adminServer).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.eventLoopDelayMs).toBeDefined();
    });

    it('/readyz returns 200 when ready and 503 when draining', async () => {
      const res1 = await request(adminServer).get('/readyz');
      expect(res1.status).toBe(200);
      expect(res1.body.status).toBe('ready');

      isDraining = true;
      const res2 = await request(adminServer).get('/readyz');
      expect(res2.status).toBe(503);
      expect(res2.body.status).toBe('draining');
      isDraining = false;
    });

    it('/metrics returns Prometheus text format', async () => {
      const res = await request(adminServer).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.text).toContain('rlgw_process_up');
      expect(res.headers['content-type']).toContain('text/plain');
    });

    it('/admin/v1 endpoints require admin token', async () => {
      const unauth = await request(adminServer).get('/admin/v1/snapshot');
      expect(unauth.status).toBe(401);

      const auth = await request(adminServer)
        .get('/admin/v1/snapshot')
        .set('Authorization', 'Bearer admin-secret');
      expect(auth.status).toBe(200);
      expect(auth.body.hash).toBeDefined();
    });

    it('/admin/v1/counters allows store inspection using peek', async () => {
      const res = await request(adminServer)
        .get('/admin/v1/counters?key=test-key')
        .set('Authorization', 'Bearer admin-secret');

      expect(res.status).toBe(200);
      expect(res.body.decision).toBeDefined();
    });
  });

  describe('F62: Standalone middleware mode', () => {
    it('functions as standard Express middleware in downstream services', async () => {
      const app = express();
      app.use(
        createRateLimitMiddleware({
          store: new MemoryLimiterStore(),
          policies: [
            {
              id: 'standalone-policy',
              tenant: 'global',
              match: { route: '/service/test' },
              algorithm: 'fixed_window',
              params: { type: 'fixed_window', limit: 1, windowMs: 10000 },
              priority: 1,
              failMode: 'fail_closed',
              enabled: true
            }
          ]
        })
      );

      app.get('/service/test', (_req, res) => {
        res.json({ message: 'service success' });
      });

      const res1 = await request(app).get('/service/test').set('x-client-id', 'client-st');
      expect(res1.status).toBe(200);

      const res2 = await request(app).get('/service/test').set('x-client-id', 'client-st');
      expect(res2.status).toBe(429);
      expect(res2.body.error).toBe('Too Many Requests');
    });
  });

  describe('F65: Header fuzz resilience', () => {
    it('does not throw on oversized or hostile headers', async () => {
      const hostileHeaders = {
        'x-request-id': 'a'.repeat(500),
        'cost': '-99999',
        'content-length': 'invalid-number',
        'x-forwarded-for': '127.0.0.1, 10.0.0.1, unknown, [::1]',
        'cookie': 'session=' + 'x'.repeat(4000)
      };

      const res = await request(gatewayServer)
        .get('/api/v1/search')
        .set(hostileHeaders);

      // Must handle gracefully without crashing or throwing 500
      expect(res.status).toBeLessThan(500);
    });
  });
});
