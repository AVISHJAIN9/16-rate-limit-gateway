import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'yaml';

export interface SeedResult {
  tenants: string[];
  policiesCount: number;
  apiKeys: Record<string, string[]>;
  adminUsers: Array<{ username: string; role: string; token: string }>;
  overrides: number;
  allowlistCount: number;
  denylistCount: number;
}

export async function runSeed(): Promise<SeedResult> {
  const localDir = path.resolve(process.cwd(), '.local');
  fs.mkdirSync(localDir, { recursive: true, mode: 0o700 });

  // 1. Generate dev secrets into .local/secrets.env with 0600 permissions
  const secretsPath = path.join(localDir, 'secrets.env');
  const pepper = crypto.randomBytes(32).toString('hex');
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const adminStaticToken = 'adm-secret-super-key';

  const secretsEnv = [
    `# Auto-generated dev secrets for RLGW`,
    `PEPPER=${pepper}`,
    `JWT_SECRET=${jwtSecret}`,
    `ADMIN_STATIC_TOKEN=${adminStaticToken}`,
    `RLGW_ENV=development`
  ].join('\n') + '\n';

  fs.writeFileSync(secretsPath, secretsEnv, { mode: 0o600 });
  try {
    fs.chmodSync(secretsPath, 0o600);
  } catch {
    // Ignore on non-posix
  }

  // 2. Generate API Keys (2 per tenant: acme, globex)
  const apiKeys: Record<string, string[]> = {
    acme: [
      `ak_acme_live_${crypto.randomBytes(16).toString('hex')}`,
      `ak_acme_test_${crypto.randomBytes(16).toString('hex')}`
    ],
    globex: [
      `ak_globex_live_${crypto.randomBytes(16).toString('hex')}`,
      `ak_globex_test_${crypto.randomBytes(16).toString('hex')}`
    ]
  };

  const keysPath = path.join(localDir, 'seed-keys.json');
  fs.writeFileSync(keysPath, JSON.stringify(apiKeys, null, 2), { mode: 0o600 });

  // 3. Documented dev admin users per RBAC role
  const adminUsers = [
    { username: 'admin', role: 'super-admin', token: 'adm-token-super-admin' },
    { username: 'tenant_lead', role: 'tenant-admin', token: 'adm-token-tenant-admin' },
    { username: 'pol_mgr', role: 'policy-admin', token: 'adm-token-policy-admin' },
    { username: 'ops_user', role: 'operator', token: 'adm-token-operator' },
    { username: 'read_user', role: 'viewer', token: 'adm-token-viewer' }
  ];

  // 4. Seed comprehensive policies covering all algorithms and scopes
  const policies = [
    // 1. Global IP fallback (token_bucket, global)
    {
      id: 'pol-global-fallback',
      name: 'Global IP Fallback Limiter',
      tenant: 'global',
      scope: 'ip',
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 1000, refillRate: 500 },
      priority: 10,
      enabled: true,
      failMode: 'fail_open',
      match: { route: '/*' }
    },
    // 2. Acme Client GCRA (gcra, client)
    {
      id: 'pol-acme-users-gcra',
      name: 'Acme User Profile GCRA Limiter',
      tenant: 'acme',
      scope: 'client',
      algorithm: 'gcra',
      params: { type: 'gcra', capacity: 50, ratePerSecond: 10 },
      priority: 50,
      enabled: true,
      failMode: 'fail_closed',
      match: { route: '/api/v1/users/*' }
    },
    // 3. Acme User Sliding Window Counter (sliding_window_counter, user)
    {
      id: 'pol-acme-search-sliding',
      name: 'Acme Search Query Sliding Counter',
      tenant: 'acme',
      scope: 'user',
      algorithm: 'sliding_window_counter',
      params: { type: 'sliding_window_counter', limit: 30, windowMs: 10000 },
      priority: 60,
      enabled: true,
      failMode: 'fail_closed',
      match: { route: '/api/v1/search/*' }
    },
    // 4. Globex Route Fixed Window (fixed_window, route)
    {
      id: 'pol-globex-checkout-fixed',
      name: 'Globex Checkout Fixed Window Limit',
      tenant: 'globex',
      scope: 'route',
      algorithm: 'fixed_window',
      params: { type: 'fixed_window', limit: 20, windowMs: 5000 },
      priority: 70,
      enabled: true,
      failMode: 'fail_closed',
      match: { route: '/api/v1/checkout/*' }
    },
    // 5. Globex Endpoint Group Leaky Bucket (leaky_bucket, client)
    {
      id: 'pol-globex-export-leaky',
      name: 'Globex Data Export Leaky Bucket',
      tenant: 'globex',
      scope: 'client',
      algorithm: 'leaky_bucket',
      params: { type: 'leaky_bucket', capacity: 10, leakRate: 2, variant: 'policing' },
      priority: 80,
      enabled: true,
      failMode: 'fail_closed',
      match: { route: '/api/v1/export/*' }
    },
    // 6. Sliding Window Log audit limit (sliding_window_log, client)
    {
      id: 'pol-global-audit-log',
      name: 'Global High-Precision Sliding Log Limit',
      tenant: 'global',
      scope: 'client',
      algorithm: 'sliding_window_log',
      params: { type: 'sliding_window_log', limit: 15, windowMs: 3000, maxEntries: 100 },
      priority: 90,
      enabled: true,
      failMode: 'fail_closed',
      match: { route: '/api/v1/audit/*' }
    },
    // 7. Base template policy for inheritance chain
    {
      id: 'pol-base-template',
      name: 'Base API Protection Template',
      tenant: 'acme',
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 100, refillRate: 20 },
      priority: 20,
      enabled: false,
      failMode: 'fail_closed',
      match: { route: '/api/v1/templates/*' }
    },
    // 8. Child policy inheriting from pol-base-template
    {
      id: 'pol-child-tier2',
      parentId: 'pol-base-template',
      name: 'Tier 2 Inherited Profile',
      tenant: 'acme',
      algorithm: 'token_bucket',
      params: { type: 'token_bucket', capacity: 200, refillRate: 50 },
      priority: 30,
      enabled: true,
      failMode: 'fail_closed',
      match: { route: '/api/v1/templates/tier2/*' }
    }
  ];

  const policiesYamlPath = path.resolve(process.cwd(), 'examples/policies.yaml');
  const yamlContent = yaml.stringify({ version: '1.0', policies });
  fs.writeFileSync(policiesYamlPath, yamlContent, 'utf8');

  // 5. Seed overrides and access lists in .local/seed-state.json
  const seedState = {
    overrides: [
      { key: 'client:vip_acme_corp', multiplier: 3.0, ttlSeconds: 3600, reason: 'VIP holiday migration' }
    ],
    allowlist: [
      { type: 'ip', value: '127.0.0.1', reason: 'Internal loopback monitor' },
      { type: 'client', value: 'crawler-partner-trusted', reason: 'Partner indexing bot' }
    ],
    denylist: [
      { type: 'ip', value: '198.51.100.42', reason: 'DDoS mitigation incident #4102' }
    ],
    pendingApprovals: [
      { id: 'apr-101', policyId: 'pol-acme-users-gcra', requestedBy: 'ops_user', changes: { capacity: 100 }, status: 'pending' }
    ]
  };

  const statePath = path.join(localDir, 'seed-state.json');
  fs.writeFileSync(statePath, JSON.stringify(seedState, null, 2), 'utf8');

  return {
    tenants: ['acme', 'globex'],
    policiesCount: policies.length,
    apiKeys,
    adminUsers,
    overrides: seedState.overrides.length,
    allowlistCount: seedState.allowlist.length,
    denylistCount: seedState.denylist.length
  };
}

if (process.argv[1]?.endsWith('seed-dev.ts')) {
  runSeed().then((res) => {
    console.log('\n======================================================');
    console.log('   RLGW LOCAL DEVELOPMENT SEED COMPLETE (IDEMPOTENT)  ');
    console.log('======================================================');
    console.log(`✓ Tenants:          ${res.tenants.join(', ')}`);
    console.log(`✓ Policies Seeded:  ${res.policiesCount} (all algorithms + inheritance)`);
    console.log(`✓ API Keys:         Saved to .local/seed-keys.json (2 per tenant)`);
    console.log(`✓ Secrets:          Saved to .local/secrets.env (mode 0600)`);
    console.log(`✓ Overrides:        ${res.overrides}`);
    console.log(`✓ Allow / Denylist: ${res.allowlistCount} allowed / ${res.denylistCount} denied`);
    console.log('✓ Admin Roles:');
    for (const u of res.adminUsers) {
      console.log(`    - ${u.username.padEnd(14)} (${u.role.padEnd(12)}) -> pass: ${u.username}123`);
    }
    console.log('======================================================\n');
  }).catch((err) => {
    console.error('Fatal error during dev seed:', err);
    process.exit(1);
  });
}
