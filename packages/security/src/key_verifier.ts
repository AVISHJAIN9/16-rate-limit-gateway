import crypto from 'node:crypto';
import { parseAPIKey, defaultClock, type Clock } from '@rlgw/core';

export interface VerifiedKeyRecord {
  keyId: string;
  hashedSecret: string; // HMAC-SHA-256(secret, pepper)
  tenant: string;
  clientId: string;
  scopes?: string[];
  expiresAtMs?: number;
  revoked?: boolean;
}

export class ConstantTimeKeyVerifier {
  private readonly pepper: Buffer;
  private readonly negativeCache = new Map<string, number>(); // keyId -> expiresAtMs
  private readonly negativeCacheTTLMs: number;
  private readonly clock: Clock;

  constructor(
    pepper: string = 'rlgw_default_secret_pepper_2026',
    negativeCacheTTLMs: number = 5000,
    clock: Clock = defaultClock
  ) {
    this.pepper = Buffer.from(pepper, 'utf8');
    this.negativeCacheTTLMs = negativeCacheTTLMs;
    this.clock = clock;
  }

  hashSecret(secret: string): string {
    return crypto.createHmac('sha256', this.pepper).update(secret).digest('hex');
  }

  verifyKey(
    rawKey: string,
    record: VerifiedKeyRecord,
    nowMs: number = this.clock.nowMs(),
    requiredTenant?: string,
    requiredScope?: string
  ): { valid: boolean; reason?: string } {
    let parsed;
    try {
      parsed = parseAPIKey(rawKey);
    } catch {
      return { valid: false, reason: 'malformed_key' };
    }

    if (parsed.keyId !== record.keyId) {
      return { valid: false, reason: 'key_id_mismatch' };
    }

    // Check negative cache
    const negExpiry = this.negativeCache.get(parsed.keyId);
    if (negExpiry && nowMs < negExpiry) {
      return { valid: false, reason: 'key_revoked_or_invalid_cached' };
    }

    // Check revocation
    if (record.revoked) {
      this.negativeCache.set(parsed.keyId, nowMs + this.negativeCacheTTLMs);
      return { valid: false, reason: 'key_revoked' };
    }

    // Check expiration
    if (record.expiresAtMs && nowMs >= record.expiresAtMs) {
      return { valid: false, reason: 'key_expired' };
    }

    // Check tenant binding
    if (requiredTenant && requiredTenant !== '*' && record.tenant !== 'global' && record.tenant !== requiredTenant) {
      return { valid: false, reason: 'tenant_mismatch' };
    }

    // Check scope
    if (requiredScope && record.scopes && !record.scopes.includes(requiredScope) && !record.scopes.includes('*')) {
      return { valid: false, reason: 'scope_unauthorized' };
    }

    // Constant-time comparison of hashed secret
    const incomingHashed = this.hashSecret(parsed.secret);
    const bufA = Buffer.from(incomingHashed, 'hex');
    const bufB = Buffer.from(record.hashedSecret, 'hex');

    if (bufA.length !== bufB.length) {
      return { valid: false, reason: 'secret_mismatch' };
    }

    const matched = crypto.timingSafeEqual(bufA, bufB);
    if (!matched) {
      return { valid: false, reason: 'secret_mismatch' };
    }

    return { valid: true };
  }

  revokeKey(keyId: string): void {
    this.negativeCache.set(keyId, this.clock.nowMs() + this.negativeCacheTTLMs);
  }
}
