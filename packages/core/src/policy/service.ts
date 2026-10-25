import type { Policy } from '../types.js';
import type { FilePolicyStore } from './filestore.js';
import { defaultClock, type Clock } from '../clock.js';

export interface PolicyDiff {
  field: string;
  from: any;
  to: any;
}

export interface RollbackResult {
  policy: Policy;
  rolledToVersion: number;
  newVersion: number;
  diff: PolicyDiff[];
}

export class PolicyService {
  constructor(
    private readonly store: FilePolicyStore,
    private readonly clock: Clock = defaultClock
  ) {}

  createPolicy(tenant: string, policy: Policy, author: string = 'admin'): Policy {
    const existing = this.store.getPolicy(tenant, policy.id);
    if (existing) {
      throw new Error(`policy ${policy.id} already exists`);
    }

    const pWithMeta: Policy = {
      ...policy,
      tenant: tenant || policy.tenant || 'global',
    };
    (pWithMeta as any).revision = 1;
    (pWithMeta as any).version = 1;

    this.store.savePolicy(tenant, pWithMeta);
    this.store.saveVersion(tenant, policy.id, {
      version: 1,
      policy: pWithMeta,
      author,
      reason: 'initial creation',
      createdAtMs: this.clock.nowMs(),
    });

    return pWithMeta;
  }

  getPolicy(tenant: string, id: string): Policy | null {
    return this.store.getPolicy(tenant, id);
  }

  listPolicies(tenant?: string): Policy[] {
    return this.store.listPolicies(tenant);
  }

  updatePolicy(tenant: string, id: string, policy: Policy, ifMatchRevision?: number, author: string = 'admin', reason: string = 'update'): Policy {
    const existing = this.store.getPolicy(tenant, id);
    if (!existing) {
      throw new Error(`policy ${id} not found`);
    }

    const curRevision = (existing as any).revision ?? 1;
    if (ifMatchRevision !== undefined && ifMatchRevision !== curRevision) {
      throw new Error(`precondition failed: revision ${ifMatchRevision} does not match current revision ${curRevision}`);
    }

    const curVersion = (existing as any).version ?? 1;
    const nextVersion = curVersion + 1;
    const nextRevision = curRevision + 1;

    const updated: Policy = {
      ...policy,
      id,
      tenant: tenant || existing.tenant || 'global',
    };
    (updated as any).revision = nextRevision;
    (updated as any).version = nextVersion;

    this.store.savePolicy(tenant, updated);
    this.store.saveVersion(tenant, id, {
      version: nextVersion,
      policy: updated,
      author,
      reason,
      createdAtMs: this.clock.nowMs(),
    });

    return updated;
  }

  deletePolicy(tenant: string, id: string): boolean {
    return this.store.deletePolicy(tenant, id);
  }

  rollbackPolicy(
    tenant: string,
    id: string,
    targetVersion: number,
    author: string = 'admin',
    reason: string = 'rollback'
  ): RollbackResult {
    const existing = this.store.getPolicy(tenant, id);
    if (!existing) {
      throw new Error(`policy ${id} not found`);
    }

    const versions = this.store.getVersions(tenant, id);
    const targetRec = versions.find((v) => v.version === targetVersion);
    if (!targetRec) {
      throw new Error(`target version ${targetVersion} not found for policy ${id}`);
    }

    const diff = this.diffPolicy(existing, targetRec.policy);
    const curVersion = (existing as any).version ?? 1;
    const nextVersion = curVersion + 1;
    const curRevision = (existing as any).revision ?? 1;
    const nextRevision = curRevision + 1;

    const rolled: Policy = {
      ...targetRec.policy,
      id,
      tenant: tenant || existing.tenant || 'global',
    };
    (rolled as any).version = nextVersion;
    (rolled as any).revision = nextRevision;

    this.store.savePolicy(tenant, rolled);
    this.store.saveVersion(tenant, id, {
      version: nextVersion,
      policy: rolled,
      author,
      reason: `rollback to v${targetVersion}: ${reason}`,
      createdAtMs: this.clock.nowMs(),
    });

    return {
      policy: rolled,
      rolledToVersion: targetVersion,
      newVersion: nextVersion,
      diff,
    };
  }

  diffPolicy(a: Policy, b: Policy): PolicyDiff[] {
    const diffs: PolicyDiff[] = [];
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);

    for (const k of allKeys) {
      if (k === 'version' || k === 'revision') continue;
      const valA = (a as any)[k];
      const valB = (b as any)[k];
      if (JSON.stringify(valA) !== JSON.stringify(valB)) {
        diffs.push({
          field: k,
          from: valA,
          to: valB,
        });
      }
    }

    return diffs;
  }
}
