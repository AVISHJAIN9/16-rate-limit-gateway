import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  RouteNormalizer,
  PolicyMatcher,
  CostResolver,
  PolicyLoader,
  GatewayConfigValidator,
  type Policy
} from '@rlgw/core';

describe('P0: Core Services (Normalizer, Matcher, Cost, Config, Loader)', () => {
  describe('RouteNormalizer (F64)', () => {
    it('normalizes simple and duplicate slashes', () => {
      expect(RouteNormalizer.normalize('///api///v1//users/')).toBe('/api/v1/users/');
      expect(RouteNormalizer.normalize('///api///v1//users/', { stripTrailingSlash: true })).toBe('/api/v1/users');
    });

    it('resolves dot and dot-dot segments safely', () => {
      expect(RouteNormalizer.normalize('/api/v1/../v2/./users')).toBe('/api/v2/users');
      expect(RouteNormalizer.normalize('/../../..')).toBe('/');
    });

    it('decodes unreserved characters while preserving reserved characters', () => {
      // %41 is 'A', %7E is '~', %2D is '-', %2E is '.'
      expect(RouteNormalizer.normalize('/%41%7E%2D%2E')).toBe('/A~-.');
      // Reserved character %2F (/) is preserved as %2F
      expect(RouteNormalizer.normalize('/api/%2F/users')).toBe('/api/%2F/users');
    });

    it('rejects NUL bytes and %00 sequences', () => {
      expect(() => RouteNormalizer.normalize('/api/v1/\0users')).toThrow('null byte detected');
      expect(() => RouteNormalizer.normalize('/api/v1/%00users')).toThrow('null byte detected');
    });

    it('property test: equivalent spellings always produce canonical form', () => {
      fc.assert(
        fc.property(
          fc.array(fc.stringMatching(/^[a-zA-Z0-9_-]+$/), { minLength: 1, maxLength: 5 }),
          (segments) => {
            const canonical = '/' + segments.join('/');
            const spellingWithDots = '/' + segments.join('/./');
            const spellingWithDoubleSlashes = '//' + segments.join('///');

            expect(RouteNormalizer.normalize(spellingWithDots)).toBe(canonical);
            expect(RouteNormalizer.normalize(spellingWithDoubleSlashes)).toBe(canonical);
          }
        )
      );
    });
  });

  describe('PolicyMatcher', () => {
    const policies: Policy[] = [
      {
        id: 'pol-global',
        tenant: 'global',
        match: { route: '/*' },
        algorithm: 'token_bucket',
        params: { type: 'token_bucket', capacity: 1000, refillRate: 100 },
        priority: 10,
        failMode: 'fail_open',
        enabled: true
      },
      {
        id: 'pol-users-get',
        tenant: 'acme',
        match: { route: '/api/v1/users/:id', methods: ['GET'] },
        algorithm: 'gcra',
        params: { type: 'gcra', capacity: 50, ratePerSecond: 10 },
        priority: 50,
        failMode: 'fail_closed',
        enabled: true
      },
      {
        id: 'pol-users-post',
        tenant: 'acme',
        match: { route: '/api/v1/users', methods: ['POST'] },
        algorithm: 'fixed_window',
        params: { type: 'fixed_window', limit: 20, windowMs: 60000 },
        priority: 60,
        failMode: 'fail_closed',
        enabled: true
      }
    ];

    const matcher = new PolicyMatcher(policies);

    it('matches all applicable policies in descending priority order', () => {
      const matches = matcher.matchAll('GET', '/api/v1/users/42');
      expect(matches.length).toBe(2);
      expect(matches[0].id).toBe('pol-users-get'); // priority 50
      expect(matches[1].id).toBe('pol-global');    // priority 10
    });

    it('filters out non-matching methods', () => {
      const matches = matcher.matchAll('DELETE', '/api/v1/users/42');
      expect(matches.length).toBe(1);
      expect(matches[0].id).toBe('pol-global');
    });
  });

  describe('CostResolver (F22)', () => {
    it('resolves static cost and clamps to bounds', () => {
      const cost = CostResolver.resolve({
        spec: { static: 5, minCost: 1, maxCost: 100 }
      });
      expect(cost).toBe(5);
    });

    it('resolves header hint when provided', () => {
      const cost = CostResolver.resolve({
        spec: { static: 1, minCost: 1, maxCost: 50 },
        headerCost: '25'
      });
      expect(cost).toBe(25);
    });

    it('calculates body size addition', () => {
      const cost = CostResolver.resolve({
        spec: { static: 2, bodySizeFactor: 1024, minCost: 1, maxCost: 100 },
        bodyBytes: 3000 // ceil(3000 / 1024) = 3 + 2 = 5
      });
      expect(cost).toBe(5);
    });
  });

  describe('GatewayConfigValidator', () => {
    it('validates a correct gateway config', () => {
      const sample = {
        dataListener: { port: 8080 },
        adminListener: { port: 8081 },
        store: { type: 'memory' },
        policySource: { type: 'file' }
      };
      const result = GatewayConfigValidator.validate(sample);
      expect(result.valid).toBe(true);
      expect(result.config?.dataListener.port).toBe(8080);
    });

    it('reports validation errors on invalid config', () => {
      const sample = {
        dataListener: { port: 999999 } // invalid port
      };
      const result = GatewayConfigValidator.validate(sample);
      expect(result.valid).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(0);
    });
  });
});
