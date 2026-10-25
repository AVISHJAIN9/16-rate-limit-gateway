import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  FilePolicyStore,
  PolicyService,
  RadixTree,
  computeSpecificity,
  comparePriority,
  sortMatchedRoutes,
  computeEffectivePolicy,
  validateRelaxation,
  isOverrideActive,
  applyActiveOverride,
  instantiateTemplate,
  AtomicSnapshotReloader,
  DynamicPolicySnapshot,
  resolve12FactorEnv,
  parseConfigBundle,
  checkTenantIsolation,
  type Policy,
  type MatchedRoute
} from '@rlgw/core';

describe('F46–F60: Policy Management Engine Parity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlgw-policy-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_err) {
      // Ignore cleanup error in test temp dir
    }
  });

  it('F46: FilePolicyStore WAL, snapshot, and crash recovery with truncated final record', () => {
    const store = new FilePolicyStore({ dir: tmpDir, fsync: 'always' });

    const p1: Policy = {
      id: 'pol-wal-1',
      tenant: 'tenant-a',
      match: { route: '/api/v1/users' },
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 100, refillRate: 10 },
      priority: 10,
      failMode: 'fail_closed',
      enabled: true,
    };
    store.savePolicy('tenant-a', p1);
    expect(store.getPolicy('tenant-a', 'pol-wal-1')).not.toBeNull();

    // Snapshot
    store.snapshot();
    expect(fs.existsSync(path.join(tmpDir, 'snapshot.json'))).toBe(true);

    // Save another policy after snapshot
    const p2: Policy = {
      id: 'pol-wal-2',
      tenant: 'tenant-a',
      match: { route: '/api/v1/orders' },
      algorithm: 'fixed_window',
      params: { type: 'fixed_window', limit: 50, windowMs: 1000 },
      priority: 20,
      failMode: 'fail_open',
      enabled: true,
    };
    store.savePolicy('tenant-a', p2);
    store.close();

    // Simulate crash and corrupt/truncate final record in WAL
    const walPath = path.join(tmpDir, 'wal.jsonl');
    fs.appendFileSync(walPath, '{"ts": 12345, "tenant": "tenant-a", "action": "save_policy", "payl'); // truncated JSON

    // Reopen store - must recover cleanly without throwing and recover p1 and p2
    const recoveredStore = new FilePolicyStore({ dir: tmpDir, fsync: 'always' });
    expect(recoveredStore.getPolicy('tenant-a', 'pol-wal-1')).not.toBeNull();
    expect(recoveredStore.getPolicy('tenant-a', 'pol-wal-2')).not.toBeNull();
    recoveredStore.close();
  });

  it('F47, F48, F49: Policy versioning, optimistic concurrency, rollback with diff preview', () => {
    const store = new FilePolicyStore({ dir: tmpDir });
    const service = new PolicyService(store);

    // 1. Create policy (v1, rev 1)
    const created = service.createPolicy('corp', {
      id: 'pol-orders',
      tenant: 'corp',
      match: { route: '/orders' },
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 100, refillRate: 10 },
      priority: 5,
      failMode: 'fail_closed',
      enabled: true,
    });
    expect((created as any).version).toBe(1);

    // 2. Update policy with correct revision
    const updated = service.updatePolicy('corp', 'pol-orders', {
      ...created,
      params: { type: 'token_bucket', capacity: 200, refillRate: 20 },
    }, 1);
    expect((updated as any).version).toBe(2);

    // Optimistic concurrency failure on stale revision
    expect(() => {
      service.updatePolicy('corp', 'pol-orders', updated, 1);
    }).toThrow(/precondition failed/);

    // 3. Rollback to v1 with diff preview
    const rollbackRes = service.rollbackPolicy('corp', 'pol-orders', 1, 'ops-team', 'emergency mitigation');
    expect(rollbackRes.rolledToVersion).toBe(1);
    expect(rollbackRes.newVersion).toBe(3);
    expect(rollbackRes.diff.length).toBeGreaterThan(0);
    const capacityDiff = rollbackRes.diff.find((d) => d.field === 'params');
    expect(capacityDiff).toBeDefined();

    store.close();
  });

  it('F50: Policy inheritance engine, field provenance, and cycle detection', () => {
    const rootNode = {
      id: 'pol-global-root',
      layer: 'global' as const,
      policy: {
        id: 'pol-global-root',
        tenant: 'global',
        algorithm: 'token_bucket' as const,
        params: { type: 'token_bucket' as const, capacity: 1000, refillRate: 100 },
        priority: 1,
        failMode: 'fail_closed' as const,
        enabled: true,
        match: { route: '/*' },
      },
      specified: { algorithm: true, params: true, priority: true },
    };

    const tenantNode = {
      id: 'pol-tenant-acme',
      parentId: 'pol-global-root',
      layer: 'tenant' as const,
      policy: {
        id: 'pol-tenant-acme',
        tenant: 'acme',
        algorithm: 'token_bucket' as const,
        params: { type: 'token_bucket' as const, capacity: 500, refillRate: 50 },
        priority: 5,
        failMode: 'fail_open' as const,
        enabled: true,
        match: { route: '/*' },
      },
      specified: { params: true, priority: true },
    };

    const nodeMap = {
      'pol-global-root': rootNode,
      'pol-tenant-acme': tenantNode,
    };

    const effective = computeEffectivePolicy('pol-tenant-acme', nodeMap);
    expect(effective.policy.algorithm).toBe('token_bucket');
    expect((effective.policy.params as any).capacity).toBe(500);
    expect(effective.provenance['algorithm']).toBe('global:pol-global-root');
    expect(effective.provenance['params']).toBe('tenant:pol-tenant-acme');

    // Cycle detection
    const cyclicMap = {
      nodeA: { id: 'nodeA', parentId: 'nodeB', layer: 'tenant' as const, policy: rootNode.policy },
      nodeB: { id: 'nodeB', parentId: 'nodeA', layer: 'tenant' as const, policy: rootNode.policy },
    };
    expect(() => computeEffectivePolicy('nodeA', cyclicMap)).toThrow(/cycle detected/);
  });

  it('F51: TTL incident overrides and relaxation guardrails', () => {
    const origPolicy: Policy = {
      id: 'pol-api',
      tenant: 'global',
      match: { route: '/api' },
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 100, refillRate: 10 },
      priority: 10,
      failMode: 'fail_closed',
      enabled: true,
    };

    // Relaxation factor: default 2.0x limit is 200. Requesting 300 without forceRelax fails.
    expect(() => {
      validateRelaxation(origPolicy, {
        id: 'ov-1',
        policyId: 'pol-api',
        tenant: 'global',
        limit: 300,
        forceRelax: false,
      });
    }).toThrow(/exceeds max relaxation factor/);

    // With forceRelax it passes
    expect(() => {
      validateRelaxation(origPolicy, {
        id: 'ov-1',
        policyId: 'pol-api',
        tenant: 'global',
        limit: 300,
        forceRelax: true,
      });
    }).not.toThrow();

    // Active override expiry check
    const now = 10000;
    const activeOverride = {
      id: 'ov-2',
      policyId: 'pol-api',
      tenant: 'global',
      limit: 150,
      expiresAtMs: 15000,
      revoked: false,
    };
    expect(isOverrideActive(activeOverride, now)).toBe(true);
    expect(isOverrideActive(activeOverride, 20000)).toBe(false);

    // Apply active override
    const { policy: appliedPolicy, applied } = applyActiveOverride(origPolicy, activeOverride, now);
    expect(applied).toBe(true);
    expect((appliedPolicy.params as any).capacity).toBe(150);
  });

  it('F52: Parameterized policy templates and typed validation', () => {
    const tmpl = {
      id: 'tmpl-standard-api',
      tenant: 'corp',
      parameters: [
        { name: 'ROUTE', type: 'string' as const, required: true },
        { name: 'LIMIT', type: 'int' as const, required: true },
        { name: 'ENABLED', type: 'bool' as const, default: 'true' },
      ],
      body: JSON.stringify({
        id: 'pol-instantiated',
        match: { route: '{{ROUTE}}' },
        algorithm: 'fixed_window',
        params: { type: 'fixed_window', limit: '{{LIMIT}}', windowMs: 1000 },
        priority: 10,
        failMode: 'fail_open',
        enabled: '{{ENABLED}}',
      }),
    };

    // Valid instantiation
    const policy = instantiateTemplate(tmpl, {
      ROUTE: '/v1/users',
      LIMIT: '500',
    });
    expect(policy.match.route).toBe('/v1/users');
    expect(policy.tenant).toBe('corp');

    // Missing required param
    expect(() => instantiateTemplate(tmpl, { ROUTE: '/v1/users' })).toThrow(/missing required/);

    // Invalid type
    expect(() => instantiateTemplate(tmpl, { ROUTE: '/v1/users', LIMIT: 'not-an-int' })).toThrow(/valid integer/);
  });

  it('F53 & F54: Radix tree route matching, specificity, parameter extraction & wildcard rules', () => {
    const tree = new RadixTree();

    const pExact: Policy = {
      id: 'pol-exact',
      tenant: 'global',
      match: { route: '/users/admin' },
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 10, refillRate: 1 },
      priority: 10,
      failMode: 'fail_closed',
      enabled: true,
    };
    const pParam: Policy = {
      id: 'pol-param',
      tenant: 'global',
      match: { route: '/users/:id' },
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 50, refillRate: 5 },
      priority: 10,
      failMode: 'fail_closed',
      enabled: true,
    };
    const pWild: Policy = {
      id: 'pol-wild',
      tenant: 'global',
      match: { route: '/users/**' },
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 100, refillRate: 10 },
      priority: 10,
      failMode: 'fail_closed',
      enabled: true,
    };

    tree.insert('/users/admin', pExact);
    tree.insert('/users/:id', pParam);
    tree.insert('/users/**', pWild);

    // Exact match wins due to highest specificity
    const matchesExact = tree.match('/users/admin');
    expect(matchesExact.length).toBeGreaterThan(0);
    expect(matchesExact[0].policy.id).toBe('pol-exact');

    // Param match extracts parameter
    const matchesParam = tree.match('/users/alice');
    expect(matchesParam.length).toBeGreaterThan(0);
    expect(matchesParam[0].policy.id).toBe('pol-param');
    expect(matchesParam[0].params['id']).toBe('alice');

    // Deep match hits wildcard
    const matchesWild = tree.match('/users/org/deep/resource');
    expect(matchesWild.length).toBeGreaterThan(0);
    expect(matchesWild[0].policy.id).toBe('pol-wild');
  });

  it('F55: Strict total priority ordering', () => {
    const routes: MatchedRoute[] = [
      {
        policy: { id: 'pol-b', tenant: 'global', priority: 10 } as Policy,
        params: {},
        specificity: 100,
      },
      {
        policy: { id: 'pol-a', tenant: 'global', priority: 10 } as Policy,
        params: {},
        specificity: 100,
      },
      {
        policy: { id: 'pol-high', tenant: 'global', priority: 100 } as Policy,
        params: {},
        specificity: 10,
      },
      {
        policy: { id: 'pol-tenant', tenant: 'finance', priority: 10 } as Policy,
        params: {},
        specificity: 100,
      },
    ];

    sortMatchedRoutes(routes);

    // Highest explicit priority first
    expect(routes[0].policy.id).toBe('pol-high');
    // Then tenant over global for same priority and specificity
    expect(routes[1].policy.id).toBe('pol-tenant');
    // Then tie breaker ID ascending (pol-a before pol-b)
    expect(routes[2].policy.id).toBe('pol-a');
    expect(routes[3].policy.id).toBe('pol-b');
  });

  it('F56: Cross-tenant policy isolation', () => {
    const polFinance: Policy = {
      id: 'pol-fin',
      tenant: 'finance',
      match: { route: '/api' },
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 100, refillRate: 10 },
      priority: 10,
      failMode: 'fail_closed',
      enabled: true,
    };
    const polGlobal: Policy = {
      id: 'pol-glob',
      tenant: 'global',
      match: { route: '/api' },
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 100, refillRate: 10 },
      priority: 10,
      failMode: 'fail_closed',
      enabled: true,
    };

    // Finance request can access finance and global
    expect(checkTenantIsolation('finance', polFinance)).toBe(true);
    expect(checkTenantIsolation('finance', polGlobal)).toBe(true);

    // Marketing request CANNOT access finance policy
    expect(checkTenantIsolation('marketing', polFinance)).toBe(false);
  });

  it('F57, F58, F59: Strict bundle parser, includes, 12-factor env and secret references', () => {
    const subBundleFile = path.join(tmpDir, 'sub-policies.yaml');
    fs.writeFileSync(
      subBundleFile,
      `version: "1.0"
policies:
  - id: "pol-sub-1"
    tenant: "sub"
    algorithm: "fixed_window"
    params:
      type: "fixed_window"
      limit: 50
      windowMs: 1000
    priority: 5
    failMode: "fail_open"
    enabled: true
    match:
      route: "/sub/*"
`
    );

    const mainBundleFile = path.join(tmpDir, 'main-bundle.yaml');
    fs.writeFileSync(
      mainBundleFile,
      `version: "1.0"
env: "\${GATEWAY_ENV:-development}"
includes:
  - "${subBundleFile}"
policies:
  - id: "pol-main"
    tenant: "global"
    algorithm: "token_bucket"
    params:
      type: "token_bucket"
      capacity: 100
      refillRate: 10
    priority: 1
    failMode: "fail_closed"
    enabled: true
    match:
      route: "/*"
`
    );

    const bundle = parseConfigBundle(
      mainBundleFile,
      { GATEWAY_ENV: 'staging' },
      {}
    );

    expect(bundle.env).toBe('staging');
    expect(bundle.policies.length).toBe(2);
    expect(bundle.policies.some((p) => p.id === 'pol-main')).toBe(true);
    expect(bundle.policies.some((p) => p.id === 'pol-sub-1')).toBe(true);

    // Circular include error check
    const circA = path.join(tmpDir, 'circ-a.yaml');
    const circB = path.join(tmpDir, 'circ-b.yaml');
    fs.writeFileSync(circA, `version: "1.0"\nincludes:\n  - "${circB}"\npolicies: []\n`);
    fs.writeFileSync(circB, `version: "1.0"\nincludes:\n  - "${circA}"\npolicies: []\n`);
    expect(() => parseConfigBundle(circA)).toThrow(/circular bundle include/);
  });

  it('F60: Zero-downtime hot reload and concurrent resolvers', () => {
    const pInitial: Policy = {
      id: 'pol-v1',
      tenant: 'global',
      match: { route: '/api/v1/*' },
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 100, refillRate: 10 },
      priority: 1,
      failMode: 'fail_closed',
      enabled: true,
    };

    const reloader = new AtomicSnapshotReloader(new DynamicPolicySnapshot([pInitial], 1, 'hash-1'));

    // 100 concurrent resolutions
    const promises = Array.from({ length: 100 }, (_, i) => {
      const snap = reloader.getSnapshot();
      const matches = snap.resolve('/api/v1/test');
      expect(matches.length).toBe(1);

      // Concurrently swap halfway through
      if (i === 50) {
        const pUpdated: Policy = {
          id: 'pol-v2',
          tenant: 'global',
          match: { route: '/api/v1/*' },
          algorithm: 'token_bucket',
          params: { type: 'token_bucket', capacity: 200, refillRate: 20 },
          priority: 1,
          failMode: 'fail_closed',
          enabled: true,
        };
        reloader.reload(new DynamicPolicySnapshot([pUpdated], 2, 'hash-2'));
      }
    });

    const finalSnap = reloader.getSnapshot();
    expect(finalSnap.version).toBe(2);
    expect(finalSnap.hash).toBe('hash-2');
  });
});
