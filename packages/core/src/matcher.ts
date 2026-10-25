import type { Policy, Identity } from './types.js';

export interface RouteMatchResult {
  policy: Policy;
  params: Record<string, string>;
}

export class PolicyMatcher {
  private policies: Policy[] = [];

  constructor(policies: Policy[] = []) {
    this.setPolicies(policies);
  }

  setPolicies(policies: Policy[]): void {
    // Sort descending by priority (higher priority first)
    this.policies = [...policies]
      .filter((p) => p.enabled)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  matchAll(
    method: string,
    canonicalPath: string,
    headers: Record<string, string | string[] | undefined> = {},
    identity?: Identity
  ): Policy[] {
    const matched: Policy[] = [];

    for (const policy of this.policies) {
      if (this.matches(policy, method, canonicalPath, headers, identity)) {
        matched.push(policy);
      }
    }

    return matched;
  }

  private matches(
    policy: Policy,
    method: string,
    canonicalPath: string,
    headers: Record<string, string | string[] | undefined>,
    identity?: Identity
  ): boolean {
    const match = policy.match;

    // Check method
    if (match.methods && match.methods.length > 0) {
      const upperMethod = method.toUpperCase();
      if (!match.methods.map((m) => m.toUpperCase()).includes(upperMethod) && !match.methods.includes('*')) {
        return false;
      }
    }

    // Check route template
    if (!this.matchesRoute(match.route, canonicalPath)) {
      return false;
    }

    // Check headers
    if (match.headers) {
      for (const [headerName, expectedValue] of Object.entries(match.headers)) {
        const val = headers[headerName.toLowerCase()];
        const actualValue = Array.isArray(val) ? val.join(',') : val;
        if (actualValue !== expectedValue) {
          return false;
        }
      }
    }

    // Check identity
    if (match.identity && identity) {
      for (const [key, expectedVal] of Object.entries(match.identity)) {
        if (identity[key] !== expectedVal) {
          return false;
        }
      }
    }

    return true;
  }

  private matchesRoute(template: string, path: string): boolean {
    if (template === '*' || template === '/*') {
      return true;
    }

    const tParts = template.split('/').filter(Boolean);
    const pParts = path.split('/').filter(Boolean);

    for (let i = 0; i < tParts.length; i++) {
      const tPart = tParts[i];
      if (tPart === '*') {
        return true; // trailing wildcard matches rest
      }
      if (tPart.startsWith(':')) {
        // parameter match
        if (i >= pParts.length) return false;
        continue;
      }
      if (tPart !== pParts[i]) {
        return false;
      }
    }

    return tParts.length === pParts.length;
  }
}
