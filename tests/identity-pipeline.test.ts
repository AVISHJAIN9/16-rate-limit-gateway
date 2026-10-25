import { describe, it, expect } from 'vitest';
import {
  parseAPIKey,
  redactAPIKey,
  InMemoryKeyLookup,
  parseAndNormalizeIP,
  KeyBuilder,
  BinaryKeyWireVersion,
  getScopeKeyer,
  ResolverPipeline,
  APIKeySource,
  UserIDSource,
  ClientIPSource,
  CIDRProxyChecker,
  UntrustedProxyChecker,
  type ResolvedIdentity
} from '@rlgw/core';

describe('F1–F15: Identity, Key Building, and Scope Resolution Parity', () => {
  it('F4: APIKey parsing, validation, and redaction (TestAPIKeyParsingAndRedaction)', () => {
    const raw = 'rlk_user123_sec9876543210';
    const parsed = parseAPIKey(raw);

    expect(parsed.keyId).toBe('user123');
    expect(parsed.secret).toBe('sec9876543210');

    // Verify secret is NEVER leaked
    const redacted = redactAPIKey(parsed);
    expect(redacted).not.toContain('sec9876543210');
    expect(redacted).toBe('rlk_user123_***REDACTED***');

    // String form redaction
    expect(redactAPIKey(raw)).toBe('rlk_user123_***REDACTED***');

    // Malformed keys
    const invalidKeys = [
      '',
      'bearer_foo_bar',
      'rlk_',
      'rlk_onepart',
      'rlk_two_parts_too_many',
      'rlk__secret',
      'rlk_id_',
    ];
    for (const bad of invalidKeys) {
      expect(() => parseAPIKey(bad)).toThrow();
    }
  });

  it('F6: IP normalization matrix (TestIPNormalizationMatrix)', () => {
    const matrix = [
      { name: 'standard IPv4', raw: '192.0.2.1', prefixBits: 64, expected: '192.0.2.1' },
      { name: 'IPv4 with port', raw: '198.51.100.4:8080', prefixBits: 64, expected: '198.51.100.4' },
      { name: 'IPv4-mapped IPv6 normalization', raw: '::ffff:192.0.2.128', prefixBits: 64, expected: '192.0.2.128' },
      { name: 'IPv4-mapped IPv6 with brackets and port', raw: '[::ffff:203.0.113.19]:443', prefixBits: 64, expected: '203.0.113.19' },
      { name: 'IPv6 default /64 subnet aggregation', raw: '2001:db8:85a3:8d3:1319:8a2e:370:7348', prefixBits: 64, expected: '2001:db8:85a3:8d3::' },
      { name: 'IPv6 /64 aggregation preserves first 64 bits', raw: '2001:db8:abcd:0012:ffff:ffff:ffff:ffff', prefixBits: 64, expected: '2001:db8:abcd:12::' },
      { name: 'IPv6 /48 aggregation', raw: '2001:db8:abcd:1234::1', prefixBits: 48, expected: '2001:db8:abcd::' },
      { name: 'IPv6 /128 (exact host)', raw: '2001:db8::1', prefixBits: 128, expected: '2001:db8::1' },
    ];

    for (const tc of matrix) {
      const normalized = parseAndNormalizeIP(tc.raw, tc.prefixBits);
      expect(normalized).toBe(tc.expected);
    }
  });

  it('F8–F15: Scope Keyer Matrix (TestScopeKeyerMatrix)', () => {
    const baseID: ResolvedIdentity = {
      tenant: 'tenant-corp',
      clientId: 'client-abc',
      userId: 'user-999',
      ip: '192.0.2.50',
      route: '/api/v1/orders/{orderId}',
      method: 'POST',
      group: 'orders_group',
      source: 'test',
    };

    const tests = [
      { name: 'F9 Global scope', scope: 'global', expected: 'global' },
      { name: 'F10 Client scope present', scope: 'client', expected: 'client-abc' },
      { name: 'F10 Client scope missing with default deny', scope: 'client', mutate: (id: ResolvedIdentity) => { id.clientId = ''; }, wantDeny: true },
      { name: 'F10 Client scope missing with skip', scope: 'client', mutate: (id: ResolvedIdentity) => { id.clientId = ''; }, onMissing: 'skip' as const, wantSkip: true },
      { name: 'F10 Client scope missing with fallback to IP', scope: 'client', mutate: (id: ResolvedIdentity) => { id.clientId = ''; }, onMissing: 'fallback_ip' as const, expected: 'ip:192.0.2.50' },
      { name: 'F11 User scope present', scope: 'user', expected: 'user-999' },
      { name: 'F11 User scope missing deny', scope: 'user', mutate: (id: ResolvedIdentity) => { id.userId = undefined; }, wantDeny: true },
      { name: 'F12 IP scope present', scope: 'ip', expected: '192.0.2.50' },
      { name: 'F12 IP scope missing deny', scope: 'ip', mutate: (id: ResolvedIdentity) => { id.ip = ''; }, wantDeny: true },
      { name: 'F13 Route template scope present', scope: 'route', expected: '/api/v1/orders/{orderId}' },
      { name: 'F13 Route scope missing deny', scope: 'route', mutate: (id: ResolvedIdentity) => { id.route = ''; }, wantDeny: true },
      { name: 'F14 Tenant scope aggregate present', scope: 'tenant', expected: 'tenant-corp' },
      { name: 'F14 Tenant scope missing deny', scope: 'tenant', mutate: (id: ResolvedIdentity) => { id.tenant = ''; }, wantDeny: true },
      { name: 'F15 Endpoint group scope present', scope: 'endpoint_group', expected: 'orders_group' },
      { name: 'F15 Endpoint group missing deny', scope: 'endpoint_group', mutate: (id: ResolvedIdentity) => { id.group = undefined; }, wantDeny: true },
      { name: 'F8 Method scope present', scope: 'method', expected: 'POST' },
    ];

    for (const tc of tests) {
      const id = { ...baseID };
      if (tc.mutate) tc.mutate(id);

      const keyer = getScopeKeyer(tc.scope);
      const res = keyer.extractDimension(id, { id: 'test-pol', scope: tc.scope, onMissingIdentity: tc.onMissing });

      if (tc.wantDeny) {
        expect(res.deny).toBe(true);
      } else if (tc.wantSkip) {
        expect(res.skip).toBe(true);
      } else {
        expect(res.dimension).toBe(tc.expected);
      }
    }
  });

  it('F3: KeyBuilder Binary & Redis Cluster Hash-Tag (TestKeyBuilderBinaryAndRedisHashTag)', () => {
    const kb = new KeyBuilder({
      includePolicyVersion: false,
      namespace: 'rl',
    });

    const kc = {
      tenant: 'acme',
      scope: 'client',
      dimension: 'client-1',
      policyId: 'pol-orders',
      policyVersion: 2,
      method: 'GET',
      attributes: {
        env: 'prod',
        region: 'us-east-1',
      },
    };

    // 1. Redis cluster hash-tag format
    const redisKey = kb.buildRedisKey(kc);
    expect(redisKey).toBe('rl:{acme:client-1}:client:pol-orders:GET');

    // 2. Binary key generation with wire version 0x01
    const binKey = kb.buildBinaryKey(kc);
    expect(binKey.length).toBeGreaterThan(0);
    expect(binKey[0]).toBe(BinaryKeyWireVersion);

    // 3. Frozen interface backwards-compatibility
    const legacyKey = kb.build('acme', 'client-1', 'pol-orders', 'token_bucket', 12345);
    expect(legacyKey).toBe('rl:v1:{acme:client-1}:pol-orders:token_bucket:12345');
  });

  it('F2: Request identity resolution pipeline (TestResolverPipelineStages)', async () => {
    const lookup = new InMemoryKeyLookup();
    lookup.registerKey({ keyId: 'key-finance', secret: 'sec123', clientId: 'fin-client', tenant: 'finance' });

    const pipeline = new ResolverPipeline()
      .addStage(new APIKeySource(lookup))
      .addStage(new UserIDSource('x-user-id'))
      .setIPSource(new ClientIPSource(new UntrustedProxyChecker()));

    // 1. Resolve with API key
    const resApiKey = await pipeline.resolve({
      headers: { 'x-api-key': 'rlk_key-finance_sec123' },
      ip: '198.51.100.1',
      method: 'POST',
      path: '/api/v1/invoices',
    });
    expect(resApiKey.clientId).toBe('fin-client');
    expect(resApiKey.tenant).toBe('finance');
    expect(resApiKey.source).toBe('api_key');
    expect(resApiKey.ip).toBe('198.51.100.1');

    // 2. Resolve without API key -> falls back to UserID and IP
    const resUser = await pipeline.resolve({
      headers: { 'x-user-id': 'usr-alice' },
      ip: '198.51.100.2',
      method: 'GET',
      path: '/api/v1/profile',
    });
    expect(resUser.userId).toBe('usr-alice');
    expect(resUser.source).toBe('user_id');
    expect(resUser.ip).toBe('198.51.100.2');

    // 3. Trusted proxy check
    const trustedChecker = new CIDRProxyChecker(['10.0.0.0/8']);
    const trustedPipeline = new ResolverPipeline()
      .setIPSource(new ClientIPSource(trustedChecker));

    const resTrusted = await pipeline.resolve({
      headers: { 'x-forwarded-for': '203.0.113.195, 10.0.0.1' },
      ip: '10.0.0.1',
      method: 'GET',
      path: '/api/v1/test',
    });
    expect(resTrusted.ip).toBe('10.0.0.1'); // Untrusted default
  });
});
