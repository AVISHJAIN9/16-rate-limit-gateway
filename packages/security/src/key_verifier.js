import crypto from 'node:crypto';
import { parseAPIKey, defaultClock } from '@rlgw/core';
export class ConstantTimeKeyVerifier {
    pepper;
    negativeCache = new Map(); // keyId -> expiresAtMs
    negativeCacheTTLMs;
    clock;
    constructor(pepper = 'rlgw_default_secret_pepper_2026', negativeCacheTTLMs = 5000, clock = defaultClock) {
        this.pepper = Buffer.from(pepper, 'utf8');
        this.negativeCacheTTLMs = negativeCacheTTLMs;
        this.clock = clock;
    }
    hashSecret(secret) {
        return crypto.createHmac('sha256', this.pepper).update(secret).digest('hex');
    }
    verifyKey(rawKey, record, nowMs = this.clock.nowMs(), requiredTenant, requiredScope) {
        let parsed;
        try {
            parsed = parseAPIKey(rawKey);
        }
        catch {
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
    revokeKey(keyId) {
        this.negativeCache.set(keyId, this.clock.nowMs() + this.negativeCacheTTLMs);
    }
}
