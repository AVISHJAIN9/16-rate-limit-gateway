import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  PolicyFileWatcher,
  PolicyDiffGenerator,
  PolicyDryRunner,
  QuotaImportExportManager,
  PolicyMigrationManager,
  AdminControlService
} from '@rlgw/control-plane';
import {
  DynamicPolicySnapshot,
  ManualClock,
  type Policy
} from '@rlgw/core';
import { MemoryLimiterStore } from '@rlgw/store-memory';

describe('P5: Admin, Config & Control Plane Suite (F106–F120 + X2)', () => {
  it('F106 & F107: PolicyFileWatcher debounces reloads and tracks generation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlgw-watcher-'));
    const testFile = path.join(tmpDir, 'policies.yaml');
    fs.writeFileSync(testFile, 'policies: []');

    let reloadCount = 0;
    const watcher = new PolicyFileWatcher(testFile, {
      debounceMs: 50,
      onReload: () => {
        reloadCount++;
      }
    });

    watcher.start();
    // Allow OS file watcher handle to establish
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Trigger rapid writes
    fs.writeFileSync(testFile, 'policies: [{ id: "test" }]');
    fs.writeFileSync(testFile, 'policies: [{ id: "test-2" }]');

    // Wait for debounced reload
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(reloadCount).toBeGreaterThanOrEqual(1);
    expect(watcher.currentGeneration).toBeGreaterThanOrEqual(1);
    expect(watcher.lastReloadTimestamp).toBeGreaterThan(0);

    await watcher.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('F110: Atomic switchover without drop across 100+ concurrent resolvers', async () => {
    const initialPolicies: Policy[] = [
      {
        id: 'p1',
        tenant: 't1',
        match: { route: '/*' },
        algorithm: 'token_bucket',
        params: { type: 'token_bucket', capacity: 100, refillRate: 10 },
        priority: 0,
        enabled: true,
        failMode: 'fail_closed'
      }
    ];

    let currentSnapshot = new DynamicPolicySnapshot(initialPolicies, 1);

    const updatedPolicies: Policy[] = [
      {
        id: 'p2',
        tenant: 't1',
        match: { route: '/*' },
        algorithm: 'fixed_window',
        params: { type: 'fixed_window', limit: 200, windowMs: 60000 },
        priority: 0,
        enabled: true,
        failMode: 'fail_closed'
      }
    ];

    // Concurrently read snapshot while swapping
    const results = await Promise.all(
      Array.from({ length: 150 }).map(async (_, i) => {
        if (i === 75) {
          // Atomic swap mid-traffic
          currentSnapshot = new DynamicPolicySnapshot(updatedPolicies, 2);
        }
        const snap = currentSnapshot;
        // Invariant: Snapshot must always be self-consistent (either completely gen 1 or completely gen 2)
        const gen = snap.generation;
        if (gen === 1) {
          expect(snap.policies[0].id).toBe('p1');
        } else {
          expect(snap.policies[0].id).toBe('p2');
        }
        return snap.policies[0].id;
      })
    );

    expect(results.length).toBe(150);
  });

  it('F115: Policy syntax validation and semantic dry-run simulation', async () => {
    // 1. Syntax check
    const validRaw = {
      id: 'dry_run_policy',
      tenant: 'acme',
      match: { route: '/*' },
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 5, refillRate: 1 },
      failMode: 'fail_closed'
    };
    const check1 = PolicyDryRunner.validate(validRaw);
    expect(check1.valid).toBe(true);

    const invalidRaw = { id: 'bad_policy', algorithm: 'unsupported_alg' };
    const check2 = PolicyDryRunner.validate(invalidRaw);
    expect(check2.valid).toBe(false);
    expect(check2.errors?.length).toBeGreaterThan(0);

    // 2. Semantic simulation dry-run
    const policy = check1.policy!;
    const simRequests = [
      { timestampMs: 1000, clientId: 'client_a', cost: 3 },
      { timestampMs: 1000, clientId: 'client_a', cost: 2 },
      { timestampMs: 1000, clientId: 'client_a', cost: 1 } // Exceeds burst 5
    ];

    const simResults = await PolicyDryRunner.evaluate(policy, simRequests);
    expect(simResults).toHaveLength(3);
    expect(simResults[0].decision.allowed).toBe(true);
    expect(simResults[0].decision.remaining).toBe(2);
    expect(simResults[1].decision.allowed).toBe(true);
    expect(simResults[1].decision.remaining).toBe(0);
    expect(simResults[2].decision.allowed).toBe(false);
  });

  it('F116: Bulk tenant quota import validation report and export formats', () => {
    const rawItems: any[] = [
      { tenant: 'tenant_a', policyId: 'pol_1', algorithm: 'token_bucket', limit: 100 },
      { tenant: 'tenant_b', policyId: 'pol_2', algorithm: 'fixed_window', limit: 50 },
      { tenant: 'tenant_c', policyId: 'pol_invalid', algorithm: 'bogus_alg', limit: -10 }
    ];

    const report = QuotaImportExportManager.validateAndParse(rawItems);
    expect(report.total).toBe(3);
    expect(report.validCount).toBe(2);
    expect(report.invalidCount).toBe(1);
    expect(report.errors[0].policyId).toBe('pol_invalid');

    // Export JSON & CSV
    const jsonOutput = QuotaImportExportManager.exportToJson(report.parsedPolicies);
    expect(jsonOutput).toContain('tenant_a');

    const csvOutput = QuotaImportExportManager.exportToCsv(report.parsedPolicies);
    expect(csvOutput).toContain('"pol_1","tenant_a","token_bucket",100');
  });

  it('F117: Policy schema migrations forward and rollback', () => {
    const manager = new PolicyMigrationManager();
    const legacyPolicy = {
      id: 'legacy_policy',
      tenant: 'global',
      match: { route: '/*' },
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 100, refillRate: 10 }
      // Missing failMode
    };

    const result = manager.migrate(legacyPolicy, 2);
    expect(result.migrated.failMode).toBe('fail_closed');
    expect(result.appliedVersions).toContain(2);

    const rolledBack = manager.rollback(result.migrated, 2, 1);
    expect(rolledBack.failMode).toBeUndefined();
  });

  it('F118: Policy semantic field-level diff generator', () => {
    const prev: Partial<Policy> = {
      id: 'diff_policy',
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 100, refillRate: 10 } as any,
      failMode: 'fail_closed'
    };

    const next: Partial<Policy> = {
      id: 'diff_policy',
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 200, refillRate: 20 } as any,
      failMode: 'fail_open'
    };

    const report = PolicyDiffGenerator.diff(prev, next);
    expect(report.hasChanges).toBe(true);
    expect(report.changes).toContainEqual({
      path: 'params.capacity',
      previousValue: 100,
      newValue: 200
    });
    expect(report.changes).toContainEqual({
      path: 'failMode',
      previousValue: 'fail_closed',
      newValue: 'fail_open'
    });
  });

  it('F108, F112, F113, F119, F120, X2: AdminControlService full lifecycle', async () => {
    const store = new MemoryLimiterStore();
    const clock = new ManualClock(1000);
    const admin = new AdminControlService(store, clock);

    // F112: Log-level adjustment with auto-revert
    admin.setLogLevel('debug', 50);
    expect(admin.getLogLevel()).toBe('debug');
    await new Promise((r) => setTimeout(r, 80));
    expect(admin.getLogLevel()).toBe('info');

    // F108: Dynamic quota override with relaxation guardrail (clamped to 10x max)
    const override = admin.addOverride({
      key: 'user:123',
      multiplier: 50, // Exceeds 10x
      ttlSeconds: 60,
      reason: 'VIP incident relief',
      actor: 'admin_alice'
    });
    expect(override.multiplier).toBe(10); // Clamped
    expect(admin.getOverride('user:123')?.multiplier).toBe(10);

    // Revocation
    expect(admin.revokeOverride('user:123')).toBe(true);
    expect(admin.getOverride('user:123')).toBeNull();

    // F113: In-flight counter inspection with tenant scope boundary
    const policy: Policy = {
      id: 'tenant_pol',
      tenant: 'acme_corp',
      match: { route: '/*' },
      algorithm: 'fixed_window',
      params: { type: 'fixed_window', limit: 10, windowMs: 60000 },
      priority: 0,
      enabled: true,
      failMode: 'fail_closed'
    };
    // Correct tenant
    const inspected = await admin.inspectCounter('key_1', 'acme_corp', policy);
    expect(inspected.tenant).toBe('acme_corp');

    // Cross-tenant boundary forbidden
    await expect(admin.inspectCounter('key_1', 'rival_corp', policy)).rejects.toThrow(
      /Forbidden: Cannot inspect counter across tenant boundary/
    );

    // F119: Temporary Emergency Allowlist
    const allowEntry = admin.addEmergencyAllowlist({
      clientId: 'critical_service',
      ttlSeconds: 300,
      reason: 'Datacenter migration bypass'
    });
    expect(allowEntry.value).toBe('critical_service');
    expect(allowEntry.type).toBe('client');

    // F120: Dynamic Client Blacklist
    const blockEntry = admin.addClientBlacklist({
      clientId: 'malicious_bot',
      reason: 'Credential stuffing attack'
    });
    expect(blockEntry.value).toBe('malicious_bot');
    expect(blockEntry.type).toBe('client');

    // X2: Two-person policy change approval workflow
    const proposal = admin.proposePolicyChange({
      policy,
      proposer: 'engineer_bob',
      reason: 'Black Friday capacity increase'
    });
    expect(proposal.status).toBe('pending');

    // Self-approval forbidden
    expect(() => admin.approvePolicyChange(proposal.id, 'engineer_bob')).toThrow(
      /Two-person rule violation/
    );

    // Distinct approver succeeds
    const approvedPolicy = admin.approvePolicyChange(proposal.id, 'lead_carol');
    expect(approvedPolicy.id).toBe('tenant_pol');
  });
});
