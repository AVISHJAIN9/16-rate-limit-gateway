import {
  type Policy,
  type LimiterStore,
  type Clock
} from '@rlgw/core';
import {
  AllowDenyListManager,
  type ListEntry
} from '@rlgw/security';

export interface PendingPolicyApproval {
  id: string;
  proposedPolicy: Policy;
  proposer: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'rejected';
  approver?: string;
  reason: string;
}

export interface DynamicOverride {
  key: string;
  multiplier: number;
  expiresAt: number;
  reason: string;
  actor: string;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export class AdminControlService {
  private currentLogLevel: LogLevel = 'info';
  private logLevelRevertTimer: NodeJS.Timeout | null = null;
  private readonly overrides = new Map<string, DynamicOverride>();
  private readonly pendingApprovals = new Map<string, PendingPolicyApproval>();
  private readonly allowDenyList: AllowDenyListManager;

  constructor(
    private readonly store: LimiterStore,
    private readonly clock: Clock,
    allowDenyList?: AllowDenyListManager
  ) {
    this.allowDenyList = allowDenyList ?? new AllowDenyListManager();
  }

  // --- F112: Runtime Log-Level Adjustment with Auto-Revert ---
  getLogLevel(): LogLevel {
    return this.currentLogLevel;
  }

  setLogLevel(level: LogLevel, revertAfterMs?: number): void {
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
  addOverride(override: {
    key: string;
    multiplier: number;
    ttlSeconds: number;
    reason: string;
    actor: string;
  }): DynamicOverride {
    // Relaxation guardrail: multiplier capped at 10x
    const clampedMultiplier = Math.min(10, Math.max(0.1, override.multiplier));
    const expiresAt = this.clock.nowMs() + override.ttlSeconds * 1000;

    const entry: DynamicOverride = {
      key: override.key,
      multiplier: clampedMultiplier,
      expiresAt,
      reason: override.reason,
      actor: override.actor
    };

    this.overrides.set(override.key, entry);
    return entry;
  }

  getOverride(key: string): DynamicOverride | null {
    const entry = this.overrides.get(key);
    if (!entry) return null;
    if (this.clock.nowMs() > entry.expiresAt) {
      this.overrides.delete(key);
      return null;
    }
    return entry;
  }

  revokeOverride(key: string): boolean {
    return this.overrides.delete(key);
  }

  removeOverride(key: string): boolean {
    return this.revokeOverride(key);
  }

  listOverrides(): DynamicOverride[] {
    return Array.from(this.overrides.values());
  }

  listAllowlist(): ListEntry[] {
    return this.allowDenyList.listAllowlist();
  }

  listDenylist(): ListEntry[] {
    return this.allowDenyList.listDenylist();
  }

  addToAllowlist(type: string, value: string, reason?: string): void {
    this.allowDenyList.addToAllowlist({
      type: type as any,
      value,
      reason
    });
  }

  removeFromAllowlist(target: string): void {
    this.allowDenyList.removeFromAllowlist(target);
  }

  addToDenylist(type: string, value: string, reason?: string): void {
    this.allowDenyList.addToDenylist({
      type: type as any,
      value,
      reason
    });
  }

  removeFromDenylist(target: string): void {
    this.allowDenyList.removeFromDenylist(target);
  }

  // --- F113: In-Flight Counter Inspection (Peek with strict tenant scoping) ---
  async inspectCounter(key: string, tenant: string, policy: Policy): Promise<any> {
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
  addEmergencyAllowlist(entry: {
    clientId?: string;
    cidr?: string;
    ttlSeconds: number;
    reason: string;
  }): ListEntry {
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
  addClientBlacklist(entry: {
    clientId?: string;
    cidr?: string;
    tenant?: string;
    ttlSeconds?: number;
    reason?: string;
  }): ListEntry {
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
  proposePolicyChange(proposal: {
    policy: Policy;
    proposer: string;
    reason: string;
    ttlMs?: number;
  }): PendingPolicyApproval {
    const id = `prop_${this.clock.nowMs()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = this.clock.nowMs();
    const entry: PendingPolicyApproval = {
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

  approvePolicyChange(proposalId: string, approver: string): Policy {
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
