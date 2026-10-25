export interface Identity {
  kind: 'client-certificate' | 'api-key' | 'user' | 'verified-user' | 'ip' | 'anonymous';
  value: string;
  namespace?: string;
}

export interface PolicyRule {
  id: string;
  name: string;
  windowMs: number;
  limit: number;
  burst: number;
  cost: number;
  scope: string;
  selector: string;
  algorithm: 'fixed-window' | 'sliding-window' | 'token-bucket';
  failOpen: boolean;
}

export interface Decision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
  retryAfterMs: number;
  policyId: string;
  ruleId: string;
  scope: string;
  reason: string;
}

export function validatePolicy(rule: PolicyRule): string[] {
  const errors: string[] = [];

  if (!rule.name || rule.name.length > 128) {
    errors.push('Policy name is required and must be <= 128 characters.');
  }

  if (rule.windowMs <= 0) {
    errors.push('windowMs must be positive.');
  }

  if (rule.limit <= 0) {
    errors.push('limit must be positive.');
  }

  if (rule.burst <= 0) {
    errors.push('burst must be positive.');
  }

  if (rule.cost <= 0) {
    errors.push('cost must be positive.');
  }

  if (rule.burst < rule.limit && rule.algorithm !== 'token-bucket') {
    errors.push('burst must be >= limit for the supplied algorithm.');
  }

  if (!rule.scope || !rule.selector) {
    errors.push('scope and selector are required.');
  }

  if (!['fixed-window', 'sliding-window', 'token-bucket'].includes(rule.algorithm)) {
    errors.push('Unknown algorithm.');
  }

  if (!rule.id) {
    errors.push('rule id is required.');
  }

  return errors;
}

export function serializePolicy(rule: PolicyRule): string {
  return JSON.stringify(rule);
}

export function parsePolicy(serialized: string): PolicyRule {
  const parsed = JSON.parse(serialized) as PolicyRule;
  return Object.freeze({ ...parsed });
}
