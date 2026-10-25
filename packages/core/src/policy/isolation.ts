import type { Policy } from '../types.js';

/**
 * Cross-tenant policy isolation checker.
 * Validates that requests scoped to tenant A never match or leak policies belonging strictly to tenant B.
 */
export function checkTenantIsolation(requestTenant: string, candidatePolicy: Policy): boolean {
  const reqT = requestTenant.trim().toLowerCase();
  const polT = (candidatePolicy.tenant || 'global').trim().toLowerCase();

  // Global policies apply to all tenants
  if (polT === 'global' || polT === '*') {
    return true;
  }

  // Exact tenant match required
  return reqT === polT;
}

export function filterIsolatedPolicies(requestTenant: string, policies: Policy[]): Policy[] {
  return policies.filter((p) => checkTenantIsolation(requestTenant, p));
}
