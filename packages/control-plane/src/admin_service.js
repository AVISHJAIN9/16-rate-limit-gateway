import { AllowDenyListManager } from '@rlgw/security';
export class AdminControlService {
    store;
    clock;
    currentLogLevel = 'info';
    logLevelRevertTimer = null;
    overrides = new Map();
    pendingApprovals = new Map();
    allowDenyList;
    constructor(store, clock, allowDenyList) {
        this.store = store;
        this.clock = clock;
        this.allowDenyList = allowDenyList ?? new AllowDenyListManager();
    }
    // --- F112: Runtime Log-Level Adjustment with Auto-Revert ---
    getLogLevel() {
        return this.currentLogLevel;
    }
    setLogLevel(level, revertAfterMs) {
        if (this.logLevelRevertTimer) {
            clearTimeout(this.logLevelRevertTimer);
            this.logLevelRevertTimer = null;
        }
        const previousLevel = this.currentLogLevel;
        this.currentLogLevel = level;
        if (revertAfterMs && revertAfterMs > 0) {
            this.logLevelRevertTimer = setTimeout(() => {
                this.currentLogLevel = previousLevel;
                this.logLevelRevertTimer = null;
            }, revertAfterMs);
        }
    }
    // --- F108: Dynamic Quota Overrides (TTL, Relaxation Guardrails) ---
    addOverride(override) {
        // Relaxation guardrail: multiplier capped at 10x
        const clampedMultiplier = Math.min(10, Math.max(0.1, override.multiplier));
        const expiresAt = this.clock.nowMs() + override.ttlSeconds * 1000;
        const entry = {
            key: override.key,
            multiplier: clampedMultiplier,
            expiresAt,
            reason: override.reason,
            actor: override.actor
        };
        this.overrides.set(override.key, entry);
        return entry;
    }
    getOverride(key) {
        const entry = this.overrides.get(key);
        if (!entry)
            return null;
        if (this.clock.nowMs() > entry.expiresAt) {
            this.overrides.delete(key);
            return null;
        }
        return entry;
    }
    revokeOverride(key) {
        return this.overrides.delete(key);
    }
    removeOverride(key) {
        return this.revokeOverride(key);
    }
    listOverrides() {
        return Array.from(this.overrides.values());
    }
    listAllowlist() {
        return this.allowDenyList.listAllowlist();
    }
    listDenylist() {
        return this.allowDenyList.listDenylist();
    }
    addToAllowlist(type, value, reason) {
        this.allowDenyList.addToAllowlist({
            type: type,
            value,
            reason
        });
    }
    removeFromAllowlist(target) {
        this.allowDenyList.removeFromAllowlist(target);
    }
    addToDenylist(type, value, reason) {
        this.allowDenyList.addToDenylist({
            type: type,
            value,
            reason
        });
    }
    removeFromDenylist(target) {
        this.allowDenyList.removeFromDenylist(target);
    }
    // --- F113: In-Flight Counter Inspection (Peek with strict tenant scoping) ---
    async inspectCounter(key, tenant, policy) {
        // Strict tenant scoping check
        if (policy.tenant !== tenant && tenant !== 'global' && policy.tenant !== 'global') {
            throw new Error(`Forbidden: Cannot inspect counter across tenant boundary (${policy.tenant} vs ${tenant})`);
        }
        const decision = await this.store.peek(key, policy.params, this.clock.nowMs(), 1);
        return {
            key,
            tenant: policy.tenant,
            policyId: policy.id,
            algorithm: policy.algorithm,
            decision
        };
    }
    // --- F119: Temporary Emergency Allowlist API ---
    addEmergencyAllowlist(entry) {
        if (!entry.reason || entry.reason.trim().length === 0) {
            throw new Error('Reason is strictly required for emergency allowlist');
        }
        const expiresAt = this.clock.nowMs() + entry.ttlSeconds * 1000;
        return this.allowDenyList.add({
            type: 'allow',
            clientId: entry.clientId,
            cidr: entry.cidr,
            reason: entry.reason,
            expiresAt
        });
    }
    // --- F120: Dynamic Client Blacklist API ---
    addClientBlacklist(entry) {
        const expiresAt = entry.ttlSeconds ? this.clock.nowMs() + entry.ttlSeconds * 1000 : undefined;
        return this.allowDenyList.add({
            type: 'deny',
            clientId: entry.clientId,
            cidr: entry.cidr,
            tenant: entry.tenant,
            reason: entry.reason ?? 'Administrative blacklist',
            expiresAt
        });
    }
    // --- X2: Policy Change Authorization & Two-Person Approval ---
    proposePolicyChange(proposal) {
        const id = `prop_${this.clock.nowMs()}_${Math.random().toString(36).slice(2, 8)}`;
        const now = this.clock.nowMs();
        const entry = {
            id,
            proposedPolicy: proposal.policy,
            proposer: proposal.proposer,
            createdAt: now,
            expiresAt: now + (proposal.ttlMs ?? 86400000), // 24h default
            status: 'pending',
            reason: proposal.reason
        };
        this.pendingApprovals.set(id, entry);
        return entry;
    }
    approvePolicyChange(proposalId, approver) {
        const proposal = this.pendingApprovals.get(proposalId);
        if (!proposal) {
            throw new Error(`Proposal ${proposalId} not found`);
        }
        if (this.clock.nowMs() > proposal.expiresAt) {
            proposal.status = 'rejected';
            throw new Error(`Proposal ${proposalId} has expired`);
        }
        if (proposal.proposer === approver) {
            throw new Error('Two-person rule violation: Proposer cannot approve their own policy change');
        }
        proposal.status = 'approved';
        proposal.approver = approver;
        return proposal.proposedPolicy;
    }
}
