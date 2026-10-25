import { type Policy, PolicySchema } from '@rlgw/core';

export interface QuotaImportItem {
  tenant: string;
  policyId: string;
  algorithm: 'token_bucket' | 'leaky_bucket' | 'fixed_window' | 'sliding_window_log' | 'sliding_window_counter' | 'gcra';
  limit: number;
  burst?: number;
  refillRate?: number;
  windowMs?: number;
}

export interface ImportValidationReport {
  total: number;
  validCount: number;
  invalidCount: number;
  errors: Array<{ index: number; tenant: string; policyId: string; reason: string }>;
  parsedPolicies: Policy[];
}

export class QuotaImportExportManager {
  static validateAndParse(items: QuotaImportItem[]): ImportValidationReport {
    const report: ImportValidationReport = {
      total: items.length,
      validCount: 0,
      invalidCount: 0,
      errors: [],
      parsedPolicies: []
    };

    items.forEach((item, index) => {
      let params: any;
      if (item.algorithm === 'token_bucket') {
        params = {
          type: 'token_bucket',
          capacity: item.limit,
          refillRate: item.refillRate ?? item.limit
        };
      } else if (item.algorithm === 'fixed_window') {
        params = {
          type: 'fixed_window',
          limit: item.limit,
          windowMs: item.windowMs ?? 60000
        };
      } else if (item.algorithm === 'gcra') {
        params = {
          type: 'gcra',
          capacity: item.limit,
          ratePerSecond: item.refillRate ?? item.limit
        };
      } else {
        params = {
          type: item.algorithm,
          limit: item.limit,
          windowMs: item.windowMs ?? 60000
        };
      }

      const policyCandidate = {
        id: item.policyId,
        tenant: item.tenant,
        match: { route: '/*' },
        algorithm: item.algorithm,
        params,
        failMode: 'fail_closed'
      };

      const parsed = PolicySchema.safeParse(policyCandidate);
      if (parsed.success) {
        report.validCount++;
        report.parsedPolicies.push(parsed.data as Policy);
      } else {
        report.invalidCount++;
        report.errors.push({
          index,
          tenant: item.tenant,
          policyId: item.policyId,
          reason: parsed.error.issues.map((i) => i.message).join(', ')
        });
      }
    });

    return report;
  }

  static exportToJson(policies: Policy[]): string {
    return JSON.stringify(policies, null, 2);
  }

  static exportToCsv(policies: Policy[]): string {
    const header = 'id,tenant,algorithm,limit,failMode';
    const rows = policies.map((p) => {
      const limit = (p.params as any)?.limit ?? (p.params as any)?.capacity ?? (p.params as any)?.rate ?? 0;
      return `"${p.id}","${p.tenant}","${p.algorithm}",${limit},"${p.failMode}"`;
    });
    return [header, ...rows].join('\n');
  }
}
