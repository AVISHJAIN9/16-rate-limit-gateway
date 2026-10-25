import { defaultClock } from '../clock.js';
export class PolicyService {
    store;
    clock;
    constructor(store, clock = defaultClock) {
        this.store = store;
        this.clock = clock;
    }
    createPolicy(tenant, policy, author = 'admin') {
        const existing = this.store.getPolicy(tenant, policy.id);
        if (existing) {
            throw new Error(`policy ${policy.id} already exists`);
        }
        const pWithMeta = {
            ...policy,
            tenant: tenant || policy.tenant || 'global',
        };
        pWithMeta.revision = 1;
        pWithMeta.version = 1;
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
    getPolicy(tenant, id) {
        return this.store.getPolicy(tenant, id);
    }
    listPolicies(tenant) {
        return this.store.listPolicies(tenant);
    }
    updatePolicy(tenant, id, policy, ifMatchRevision, author = 'admin', reason = 'update') {
        const existing = this.store.getPolicy(tenant, id);
        if (!existing) {
            throw new Error(`policy ${id} not found`);
        }
        const curRevision = existing.revision ?? 1;
        if (ifMatchRevision !== undefined && ifMatchRevision !== curRevision) {
            throw new Error(`precondition failed: revision ${ifMatchRevision} does not match current revision ${curRevision}`);
        }
        const curVersion = existing.version ?? 1;
        const nextVersion = curVersion + 1;
        const nextRevision = curRevision + 1;
        const updated = {
            ...policy,
            id,
            tenant: tenant || existing.tenant || 'global',
        };
        updated.revision = nextRevision;
        updated.version = nextVersion;
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
    deletePolicy(tenant, id) {
        return this.store.deletePolicy(tenant, id);
    }
    rollbackPolicy(tenant, id, targetVersion, author = 'admin', reason = 'rollback') {
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
        const curVersion = existing.version ?? 1;
        const nextVersion = curVersion + 1;
        const curRevision = existing.revision ?? 1;
        const nextRevision = curRevision + 1;
        const rolled = {
            ...targetRec.policy,
            id,
            tenant: tenant || existing.tenant || 'global',
        };
        rolled.version = nextVersion;
        rolled.revision = nextRevision;
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
    diffPolicy(a, b) {
        const diffs = [];
        const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of allKeys) {
            if (k === 'version' || k === 'revision')
                continue;
            const valA = a[k];
            const valB = b[k];
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
