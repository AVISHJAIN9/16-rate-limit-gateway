import type { Policy } from '../types.js';

export const DefaultMaxRelaxFactor = 2.0;

export interface OverrideRecord {
  id: string;
  policyId: string;
  tenant: string;
  limit?: number;
  burst?: number;
  expiresAtMs?: number;
  revoked?: boolean;
  forceRelax?: boolean;
  author?: string;
  reason?: string;
}

export function validateRelaxation(
  orig: Policy,
  ov: OverrideRecord,
  maxRelaxFactor: number = DefaultMaxRelaxFactor
): void {
  if (ov.forceRelax) {
    return;
  }
  const factor = maxRelaxFactor <= 1.0 ? DefaultMaxRelaxFactor : maxRelaxFactor;

  // Check limit relaxation in params
  const origParams = orig.params as any;
  const origLimit = origParams?.limit ?? origParams?.capacity ?? 0;

  if (ov.limit !== undefined && ov.limit > 0 && origLimit > 0) {
    const maxAllowed = Math.floor(origLimit * factor);
    if (ov.limit > maxAllowed) {
      throw new Error(
        `override limit ${ov.limit} exceeds max relaxation factor ${factor.toFixed(1)}x (max allowed ${maxAllowed}) without force_relax`
      );
    }
  }

  if (ov.burst !== undefined && ov.burst > 0 && origLimit > 0) {
    const maxAllowed = Math.floor(origLimit * factor);
    if (ov.burst > maxAllowed) {
      throw new Error(
        `override burst ${ov.burst} exceeds max relaxation factor ${factor.toFixed(1)}x (max allowed ${maxAllowed}) without force_relax`
      );
    }
  }
}

export function isOverrideActive(ov: OverrideRecord, nowMs: number): boolean {
  if (ov.revoked) return false;
  if (ov.expiresAtMs !== undefined && nowMs >= ov.expiresAtMs) {
    return false;
  }
  return true;
}

export function applyActiveOverride(p: Policy, ov: OverrideRecord, nowMs: number): { policy: Policy; applied: boolean } {
  if (!isOverrideActive(ov, nowMs)) {
    return { policy: p, applied: false };
  }

  const updated: Policy = {
    ...p,
    params: { ...p.params } as any,
  };

  let applied = false;
  if (ov.limit !== undefined && ov.limit > 0) {
    const params = updated.params as any;
    if (params.limit !== undefined) params.limit = ov.limit;
    if (params.capacity !== undefined) params.capacity = ov.limit;
    applied = true;
  }
  if (ov.burst !== undefined && ov.burst > 0) {
    const params = updated.params as any;
    if (params.capacity !== undefined) params.capacity = ov.burst;
    applied = true;
  }

  return { policy: updated, applied };
}
