import fs from 'node:fs';
import crypto from 'node:crypto';
import yaml from 'yaml';
import { PolicySchema } from './schema.js';
import type { Policy } from '../types.js';
import { defaultClock, type Clock } from '../clock.js';

export interface PolicySnapshot {
  hash: string;
  loadedAtMs: number;
  policies: Policy[];
  version?: string;
  generation?: number;
}

export class PolicyLoader {
  private currentSnapshot: PolicySnapshot = {
    hash: '',
    loadedAtMs: 0,
    policies: []
  };

  constructor(
    private readonly filePath?: string,
    private readonly clock: Clock = defaultClock
  ) {}

  loadFromFile(filePath?: string): PolicySnapshot {
    const targetPath = filePath ?? this.filePath;
    if (!targetPath) {
      throw new Error('PolicyLoader: No file path provided');
    }

    const rawContent = fs.readFileSync(targetPath, 'utf-8');
    return this.loadFromString(rawContent);
  }

  loadFromString(content: string): PolicySnapshot {
    let parsed: any;
    try {
      parsed = yaml.parse(content);
    } catch {
      parsed = JSON.parse(content);
    }

    const rawPolicies = Array.isArray(parsed) ? parsed : (parsed.policies ?? []);
    const version = parsed.version ?? '1.0';

    // Validate each policy
    const validatedPolicies: Policy[] = [];
    const validationErrors: Array<{ policyId?: string; error: string }> = [];

    for (const raw of rawPolicies) {
      const normalized = this.normalizeRawPolicy(raw);
      const result = PolicySchema.safeParse(normalized);
      if (result.success) {
        validatedPolicies.push(result.data as Policy);
      } else {
        validationErrors.push({
          policyId: raw?.id,
          error: result.error.message
        });
      }
    }

    if (validationErrors.length > 0) {
      throw new Error(`Policy validation failed: ${JSON.stringify(validationErrors, null, 2)}`);
    }

    // Resolve inheritance
    const resolvedPolicies = this.resolveInheritance(validatedPolicies);

    // Compute canonical snapshot hash (SHA-256)
    const canonicalJson = JSON.stringify(resolvedPolicies);
    const hash = crypto.createHash('sha256').update(canonicalJson).digest('hex');

    // Atomic snapshot swap
    this.currentSnapshot = {
      hash,
      loadedAtMs: this.clock.nowMs(), // Clock timestamp for snapshot record
      policies: resolvedPolicies,
      version
    };

    return this.currentSnapshot;
  }

  getSnapshot(): PolicySnapshot {
    return this.currentSnapshot;
  }

  private resolveInheritance(policies: Policy[]): Policy[] {
    const policyMap = new Map<string, Policy>(policies.map((p) => [p.id, p]));
    const resolved: Policy[] = [];

    for (const policy of policies) {
      if (!policy.parentId) {
        resolved.push(policy);
        continue;
      }

      const parent = policyMap.get(policy.parentId);
      if (!parent) {
        throw new Error(`Policy ${policy.id} references non-existent parent ${policy.parentId}`);
      }

      // Merge: child overrides parent
      const merged: Policy = {
        ...parent,
        ...policy,
        match: {
          ...parent.match,
          ...policy.match
        },
        params: {
          ...parent.params,
          ...policy.params
        } as any,
        labels: {
          ...(parent.labels ?? {}),
          ...(policy.labels ?? {})
        }
      };

      resolved.push(merged);
    }

    return resolved;
  }

  private normalizeRawPolicy(raw: any): any {
    if (!raw || typeof raw !== 'object') return raw;
    const policy = { ...raw };

    // Normalize match
    if (policy.match) {
      policy.match = { ...policy.match };
      if (!policy.match.route && policy.match.route_pattern) {
        policy.match.route = policy.match.route_pattern;
      }
    }

    // Normalize algorithm params if top-level limit/burst/window are present
    if (!policy.params && policy.algorithm) {
      const limit = Number(policy.limit) || 100;
      const burst = Number(policy.burst) || limit;
      const windowStr = String(policy.window || '1m');
      const windowMs = this.parseDurationMs(windowStr);
      const ratePerSec = Math.max(1, Math.round(limit / (windowMs / 1000)));

      switch (policy.algorithm) {
        case 'token_bucket':
          policy.params = {
            type: 'token_bucket',
            capacity: burst,
            refillRate: ratePerSec
          };
          break;
        case 'leaky_bucket':
          policy.params = {
            type: 'leaky_bucket',
            capacity: burst,
            leakRate: ratePerSec
          };
          break;
        case 'fixed_window':
          policy.params = {
            type: 'fixed_window',
            limit,
            windowMs
          };
          break;
        case 'sliding_window_log':
          policy.params = {
            type: 'sliding_window_log',
            limit,
            windowMs
          };
          break;
        case 'sliding_window_counter':
          policy.params = {
            type: 'sliding_window_counter',
            limit,
            windowMs
          };
          break;
        case 'gcra':
          policy.params = {
            type: 'gcra',
            capacity: burst,
            ratePerSecond: ratePerSec
          };
          break;
      }
    }

    return policy;
  }

  private parseDurationMs(duration: string): number {
    const match = duration.match(/^(\d+)(ms|s|m|h)?$/);
    if (!match) return 60000;
    const val = Number.parseInt(match[1], 10);
    const unit = match[2] || 's';
    switch (unit) {
      case 'ms': return val;
      case 's': return val * 1000;
      case 'm': return val * 60000;
      case 'h': return val * 3600000;
      default: return val * 1000;
    }
  }
}
