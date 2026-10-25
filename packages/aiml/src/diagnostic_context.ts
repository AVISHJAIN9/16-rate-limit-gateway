import { SensitiveRedactor } from '@rlgw/security';

export interface IncidentContextInput {
  incidentId: string;
  timestamp: string;
  topOffenders: Array<{ client: string; requestRate: number; rejectRatio: number }>;
  rejectReasons: Record<string, number>;
  breakerStatus: string;
  recentAuditEvents: Array<{ action: string; actor: string; details?: any }>;
  policyDiff?: string;
  metadata?: Record<string, any>;
}

export class DiagnosticContextBuilder {
  private readonly redactor: SensitiveRedactor;
  private readonly maxChars: number;

  constructor(maxChars = 8000) {
    this.redactor = new SensitiveRedactor();
    this.maxChars = maxChars;
  }

  build(input: IncidentContextInput): string {
    // 1. Redact all potential sensitive fields
    const safeOffenders = input.topOffenders.map((o) => ({
      client: this.redactor.redact(o.client),
      requestRate: o.requestRate,
      rejectRatio: o.rejectRatio
    }));

    const safeAudit = input.recentAuditEvents.map((a) => ({
      action: a.action,
      actor: this.redactor.redact(a.actor),
      details: a.details ? this.redactor.redactObject(a.details) : undefined
    }));

    const safeDiff = input.policyDiff ? this.redactor.redact(input.policyDiff) : undefined;
    const safeMetadata = input.metadata ? this.redactor.redactObject(input.metadata) : undefined;

    const contextPayload = {
      incidentId: input.incidentId,
      timestamp: input.timestamp,
      breakerStatus: input.breakerStatus,
      rejectReasons: input.rejectReasons,
      topOffenders: safeOffenders,
      recentAuditEvents: safeAudit,
      policyDiff: safeDiff,
      metadata: safeMetadata
    };

    let serialized = JSON.stringify(contextPayload, null, 2);

    // 2. Strict size budgeting
    if (serialized.length > this.maxChars) {
      serialized = serialized.slice(0, this.maxChars) + '\n... [TRUNCATED DUE TO TOKEN BUDGET]';
    }

    // 3. Final redaction pass over entire output string
    return this.redactor.redact(serialized);
  }
}
