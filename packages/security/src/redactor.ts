import { redactAPIKey } from '@rlgw/core';

export const SensitiveKeys = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'sec-websocket-key',
  'password',
  'secret',
  'token',
  'private_key',
  'api_key',
]);

/**
 * Central redactor guaranteeing that sensitive headers, secrets, tokens,
 * and keys are never printed in plaintext in logs, traces, audits, or error envelopes.
 */
export class SensitiveRedactor {
  redact(val: string): string {
    return SensitiveRedactor.redactText(val);
  }

  redactObject(obj: any): any {
    return SensitiveRedactor.redactObject(obj);
  }

  static redactText(val: string): string {
    if (!val) return val;
    let result = val;
    // Replace API keys e.g. rlk_...
    result = result.replace(/rlk_[a-zA-Z0-9_-]+/g, '[REDACTED]');
    // Replace Bearer tokens
    result = result.replace(/Bearer\s+[a-zA-Z0-9_.-]+/g, 'Bearer [REDACTED]');
    // Replace JWTs
    result = result.replace(/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[REDACTED]');
    return result;
  }

  static redactString(val: string): string {
    if (!val) return val;

    // Redact Bearer tokens
    if (val.startsWith('Bearer ')) {
      const token = val.slice(7);
      if (token.startsWith('rlk_')) {
        return `Bearer ${redactAPIKey(token)}`;
      }
      return 'Bearer [REDACTED]';
    }

    // Redact raw API keys
    if (val.startsWith('rlk_')) {
      return redactAPIKey(val);
    }

    return '[REDACTED]';
  }

  static redactHeaders(headers: Record<string, any>): Record<string, any> {
    const redacted: Record<string, any> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      if (SensitiveKeys.has(lower)) {
        if (typeof v === 'string') {
          redacted[k] = this.redactString(v);
        } else if (Array.isArray(v)) {
          redacted[k] = v.map((item) => (typeof item === 'string' ? this.redactString(item) : '***REDACTED***'));
        } else {
          redacted[k] = '***REDACTED***';
        }
      } else {
        redacted[k] = v;
      }
    }
    return redacted;
  }

  static redactObject(obj: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string') return obj;
    if (typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactObject(item));
    }

    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      const lower = k.toLowerCase();
      if (SensitiveKeys.has(lower)) {
        clean[k] = typeof v === 'string' ? this.redactString(v) : '***REDACTED***';
      } else if (typeof v === 'object') {
        clean[k] = this.redactObject(v);
      } else {
        clean[k] = v;
      }
    }
    return clean;
  }
}
