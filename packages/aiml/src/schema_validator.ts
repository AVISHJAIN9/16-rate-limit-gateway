import { z } from 'zod';
import { SensitiveRedactor } from '@rlgw/security';

export const ForensicReportSchema = z.object({
  version: z.literal(1),
  summary: z.string().min(5),
  rootCause: z.string().min(5),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).min(1),
  recommendedOperatorActions: z.array(z.string()).min(1),
  unknowns: z.array(z.string()).default([])
});

export type ForensicReport = z.infer<typeof ForensicReportSchema>;

export class LlmOutputValidator {
  private static readonly redactor = new SensitiveRedactor();

  static parseAndValidate(rawText: string): { success: boolean; report: ForensicReport; repaired: boolean } {
    // 1. Strip markdown code fences
    let cleanText = rawText.trim();
    if (cleanText.startsWith('```json')) {
      cleanText = cleanText.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    } else if (cleanText.startsWith('```')) {
      cleanText = cleanText.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    cleanText = cleanText.trim();

    // 2. Parse JSON
    let parsed: any;
    let repaired = false;
    try {
      parsed = JSON.parse(cleanText);
    } catch (_err) {
      // Attempt 1 simple heuristic repair: extract outermost { ... }
      const match = cleanText.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
          repaired = true;
        } catch {
          return { success: false, report: this.fallbackReport('JSON syntax could not be parsed'), repaired: false };
        }
      } else {
        return { success: false, report: this.fallbackReport('No valid JSON block detected in model response'), repaired: false };
      }
    }

    // 3. Validate against Zod schema
    const result = ForensicReportSchema.safeParse(parsed);
    if (!result.success) {
      return {
        success: false,
        report: this.fallbackReport(`Schema validation failed: ${result.error.issues.map((i) => i.message).join(', ')}`),
        repaired
      };
    }

    // 4. Redaction pass on output
    const safeReport: ForensicReport = {
      version: 1,
      summary: this.redactor.redact(result.data.summary),
      rootCause: this.redactor.redact(result.data.rootCause),
      confidence: result.data.confidence,
      evidence: result.data.evidence.map((e) => this.redactor.redact(e)),
      recommendedOperatorActions: result.data.recommendedOperatorActions.map((a) => this.redactor.redact(a)),
      unknowns: result.data.unknowns.map((u) => this.redactor.redact(u))
    };

    return { success: true, report: safeReport, repaired };
  }

  static fallbackReport(reason: string): ForensicReport {
    return {
      version: 1,
      summary: "Automated heuristic fallback report (LLM output unavailable or invalid)",
      rootCause: `Model output failed validation: ${reason}`,
      confidence: 0.5,
      evidence: [
        "Gateway rate-limiting metrics registered rejection surge",
        "Deterministic heuristic anomaly scoring active"
      ],
      recommendedOperatorActions: [
        "Review /admin/v1/analytics/overview for manual inspection",
        "Check /admin/v1/counters for affected client keys"
      ],
      unknowns: [
        "Attacker intent or distributed botnet signature details"
      ]
    };
  }
}
