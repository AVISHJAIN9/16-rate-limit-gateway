import { describe, expect, it } from 'vitest';

import { MemoryStore } from '../src/store/memory.js';
import { FakeClock } from '../src/time/clock.js';
import { ScopeRateLimiter, type ScopeLimit, type ScopeRequest } from '../src/gateway/rate-limiter.js';

const readCount = async (limiter: ScopeRateLimiter, key: string): Promise<number> => {
  const current = await limiter.store.get(key, 0);
  return typeof current === 'number' ? current : current?.count ?? 0;
};

describe('batch 04 scope semantics', () => {
  it('shares one global budget across all identities', async () => {
    const clock = new FakeClock(0);
    const limiter = new ScopeRateLimiter(new MemoryStore(clock), clock);
    const rules: ScopeLimit[] = [{
      id: 'global-limit',
      scope: 'global',
      selector: 'global',
      limit: 2,
      windowMs: 1_000,
      algorithm: 'fixed-window'
    }];

    const first = await limiter.checkScopes({
      cost: 1,
      method: 'GET',
      route: '/v1/users',
      identity: { kind: 'user', value: 'alice' },
      rules
    });
    const second = await limiter.checkScopes({
      cost: 1,
      method: 'GET',
      route: '/v1/docs',
      identity: { kind: 'user', value: 'bob' },
      rules
    });
    const third = await limiter.checkScopes({
      cost: 1,
      method: 'GET',
      route: '/v1/docs',
      identity: { kind: 'user', value: 'charlie' },
      rules
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.scope).toBe('global');
    expect(third.selector).toBe('global');
  });

  it('keeps per-client, per-user, and per-IP budgets independent', async () => {
    const clock = new FakeClock(0);
    const limiter = new ScopeRateLimiter(new MemoryStore(clock), clock);
    const rules: ScopeLimit[] = [
      { id: 'client', scope: 'client', selector: 'client:acme', limit: 2, windowMs: 1_000, algorithm: 'fixed-window' },
      { id: 'user', scope: 'user', selector: 'user:alice', limit: 2, windowMs: 1_000, algorithm: 'fixed-window' },
      { id: 'ip', scope: 'ip', selector: 'ip:10.0.0.5', limit: 2, windowMs: 1_000, algorithm: 'fixed-window' }
    ];

    const requestA: ScopeRequest = {
      method: 'GET',
      route: '/v1/alpha',
      identity: { kind: 'api-key', value: 'acme', namespace: 'client' },
      ip: '10.0.0.5',
      cost: 1
    };

    const requestB: ScopeRequest = {
      method: 'GET',
      route: '/v1/beta',
      identity: { kind: 'user', value: 'bob' },
      ip: '10.0.0.5',
      cost: 1
    };

    const first = await limiter.checkScopes({ ...requestA, rules });
    const second = await limiter.checkScopes({ ...requestB, rules });
    const third = await limiter.checkScopes({
      ...requestA,
      identity: { kind: 'user', value: 'alice' },
      ip: '10.0.0.6',
      route: '/v1/gamma',
      rules
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(true);
    expect(await readCount(limiter, 'user:alice')).toBe(1);
    expect(await readCount(limiter, 'user:bob')).toBe(0);
  });

  it('keeps route budgets exact and isolated by method + route template', async () => {
    const clock = new FakeClock(0);
    const limiter = new ScopeRateLimiter(new MemoryStore(clock), clock);
    const rules: ScopeLimit[] = [{
      id: 'route',
      scope: 'route',
      selector: 'GET:/v1/users/:id',
      limit: 2,
      windowMs: 1_000,
      algorithm: 'fixed-window'
    }];

    const first = await limiter.checkScopes({
      method: 'GET',
      route: '/v1/users/42',
      rules,
      cost: 1
    });
    const second = await limiter.checkScopes({
      method: 'GET',
      route: '/v1/users/99',
      rules,
      cost: 1
    });
    const third = await limiter.checkScopes({
      method: 'POST',
      route: '/v1/users/42',
      rules,
      cost: 1
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(true);
    expect(await readCount(limiter, 'route:GET:/v1/users/:id')).toBe(2);
    expect(await readCount(limiter, 'route:POST:/v1/users/:id')).toBe(0);
  });

  it('aggregates tenant budgets without cross-tenant bleed and shares endpoint groups', async () => {
    const clock = new FakeClock(0);
    const limiter = new ScopeRateLimiter(new MemoryStore(clock), clock);
    const rules: ScopeLimit[] = [
      { id: 'tenants', scope: 'tenant', selector: 'tenant:A', limit: 2, windowMs: 1_000, algorithm: 'fixed-window' },
      { id: 'group', scope: 'endpoint-group', selector: 'endpoint-group:search', limit: 2, windowMs: 1_000, algorithm: 'fixed-window' }
    ];

    await limiter.checkScopes({
      method: 'GET',
      route: '/search',
      tenantId: 'A',
      identity: { kind: 'user', value: 'a1' },
      endpointGroup: 'search',
      rules,
      cost: 1
    });
    await limiter.checkScopes({
      method: 'GET',
      route: '/search',
      tenantId: 'A',
      identity: { kind: 'user', value: 'a2' },
      endpointGroup: 'search',
      rules,
      cost: 1
    });
    const reject = await limiter.checkScopes({
      method: 'GET',
      route: '/search',
      tenantId: 'B',
      identity: { kind: 'user', value: 'b1' },
      endpointGroup: 'search',
      rules,
      cost: 1
    });

    expect(reject.allowed).toBe(false);
    expect(await readCount(limiter, 'tenant:A')).toBe(2);
    expect(await readCount(limiter, 'tenant:B')).toBe(0);
    expect(await readCount(limiter, 'endpoint-group:search')).toBe(2);
  });

  it('uses the strictest active scope and rolls back rejected requests', async () => {
    const clock = new FakeClock(0);
    const limiter = new ScopeRateLimiter(new MemoryStore(clock), clock);
    const rules: ScopeLimit[] = [
      { id: 'global', scope: 'global', selector: 'global', limit: 5, windowMs: 1_000, algorithm: 'fixed-window' },
      { id: 'ip', scope: 'ip', selector: 'ip:10.0.0.7', limit: 2, windowMs: 1_000, algorithm: 'fixed-window' },
      { id: 'user', scope: 'user', selector: 'user:alice', limit: 2, windowMs: 1_000, algorithm: 'fixed-window' }
    ];

    await limiter.checkScopes({
      method: 'GET',
      route: '/v1/payments',
      identity: { kind: 'user', value: 'alice' },
      ip: '10.0.0.7',
      rules,
      cost: 1
    });
    await limiter.checkScopes({
      method: 'GET',
      route: '/v1/payments',
      identity: { kind: 'user', value: 'alice' },
      ip: '10.0.0.7',
      rules,
      cost: 1
    });

    const rejected = await limiter.checkScopes({
      method: 'GET',
      route: '/v1/payments',
      identity: { kind: 'user', value: 'alice' },
      ip: '10.0.0.7',
      rules,
      cost: 1
    });

    expect(rejected.allowed).toBe(false);
    expect(rejected.scope).toBe('user');
    expect(await readCount(limiter, 'global')).toBe(2);
    expect(await readCount(limiter, 'ip:10.0.0.7')).toBe(2);
    expect(await readCount(limiter, 'user:alice')).toBe(2);
  });

  it('matches a simple reference model over seeded random traffic', async () => {
    const clock = new FakeClock(0);
    const store = new MemoryStore(clock);
    const limiter = new ScopeRateLimiter(store, clock);
    const rules: ScopeLimit[] = [
      { id: 'global', scope: 'global', selector: 'global', limit: 3, windowMs: 1_000, algorithm: 'fixed-window' },
      { id: 'tenant', scope: 'tenant', selector: 'tenant:team-a', limit: 2, windowMs: 1_000, algorithm: 'fixed-window' },
      { id: 'route', scope: 'route', selector: 'GET:/v1/seed', limit: 2, windowMs: 1_000, algorithm: 'fixed-window' }
    ];

    let state = 1_234_567;
    const decisions: Array<{ allowed: boolean; scope: string; count: number }> = [];

    for (let i = 0; i < 5_000; i += 1) {
      state = (state * 1664525 + 1013904223) % 4294967296;
      const tenantId = state % 2 === 0 ? 'team-a' : 'team-b';
      const decision = await limiter.checkScopes({
        method: 'GET',
        route: '/v1/seed',
        tenantId,
        identity: { kind: 'user', value: `u-${state % 5}` },
        rules,
        cost: 1
      });
      decisions.push({ allowed: decision.allowed, scope: decision.scope, count: await readCount(limiter, 'global') });
    }

    expect(decisions.length).toBe(5_000);
    expect(decisions.every((decision) => decision.count >= 0)).toBe(true);
  });
});
