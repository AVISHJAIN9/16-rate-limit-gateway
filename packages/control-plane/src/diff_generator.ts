import type { Policy } from '@rlgw/core';

export interface FieldDiff {
  path: string;
  previousValue: any;
  newValue: any;
}

export interface PolicyDiffReport {
  policyId: string;
  hasChanges: boolean;
  changes: FieldDiff[];
}

export class PolicyDiffGenerator {
  static diff(prev: Partial<Policy> | null | undefined, next: Partial<Policy>): PolicyDiffReport {
    const changes: FieldDiff[] = [];
    const policyId = next.id || prev?.id || 'unknown';

    if (!prev) {
      changes.push({ path: '(root)', previousValue: null, newValue: next });
      return { policyId, hasChanges: true, changes };
    }

    const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);

    for (const key of allKeys) {
      const prevVal = (prev as any)[key];
      const nextVal = (next as any)[key];

      if (prevVal === undefined && nextVal !== undefined) {
        changes.push({ path: key, previousValue: undefined, newValue: nextVal });
      } else if (prevVal !== undefined && nextVal === undefined) {
        changes.push({ path: key, previousValue: prevVal, newValue: undefined });
      } else if (typeof prevVal === 'object' && prevVal !== null && typeof nextVal === 'object' && nextVal !== null) {
        const subDiff = this.diffObject(key, prevVal, nextVal);
        changes.push(...subDiff);
      } else if (prevVal !== nextVal) {
        changes.push({ path: key, previousValue: prevVal, newValue: nextVal });
      }
    }

    return {
      policyId,
      hasChanges: changes.length > 0,
      changes
    };
  }

  private static diffObject(prefix: string, objA: any, objB: any): FieldDiff[] {
    const diffs: FieldDiff[] = [];
    const keys = new Set([...Object.keys(objA), ...Object.keys(objB)]);

    for (const k of keys) {
      const vA = objA[k];
      const vB = objB[k];
      const fieldPath = `${prefix}.${k}`;

      if (vA === undefined && vB !== undefined) {
        diffs.push({ path: fieldPath, previousValue: undefined, newValue: vB });
      } else if (vA !== undefined && vB === undefined) {
        diffs.push({ path: fieldPath, previousValue: vA, newValue: undefined });
      } else if (typeof vA === 'object' && vA !== null && typeof vB === 'object' && vB !== null) {
        diffs.push(...this.diffObject(fieldPath, vA, vB));
      } else if (vA !== vB) {
        diffs.push({ path: fieldPath, previousValue: vA, newValue: vB });
      }
    }

    return diffs;
  }
}
