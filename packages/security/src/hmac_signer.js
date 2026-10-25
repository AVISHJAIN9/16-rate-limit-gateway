import crypto from 'node:crypto';
import { defaultClock } from '@rlgw/core';
export class HMACRequestSigner {
    static buildCanonicalString(input) {
        const method = input.method.toUpperCase();
        const cleanPath = input.path.split('?')[0];
        // Sorted query string
        let sortedQuery = '';
        if (input.query && Object.keys(input.query).length > 0) {
            const keys = Object.keys(input.query).sort();
            sortedQuery = keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(input.query[k])}`).join('&');
        }
        // Body SHA-256
        const bodyBytes = input.body ? Buffer.from(input.body) : Buffer.alloc(0);
        const bodyHash = crypto.createHash('sha256').update(bodyBytes).digest('hex');
        return [
            method,
            cleanPath,
            sortedQuery,
            input.timestamp.toString(),
            input.nonce,
            bodyHash,
        ].join('\n');
    }
    static sign(input, secret) {
        const canonical = this.buildCanonicalString(input);
        return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    }
    static verify(input, signature, secret, nowMs = defaultClock.nowMs(), maxClockSkewMs = 300_000 // 5 minutes
    ) {
        // Clock skew check
        if (Math.abs(nowMs - input.timestamp) > maxClockSkewMs) {
            return { valid: false, reason: 'timestamp_out_of_window' };
        }
        const expected = this.sign(input, secret);
        const bufA = Buffer.from(signature, 'hex');
        const bufB = Buffer.from(expected, 'hex');
        if (bufA.length !== bufB.length) {
            return { valid: false, reason: 'signature_mismatch' };
        }
        const matched = crypto.timingSafeEqual(bufA, bufB);
        if (!matched) {
            return { valid: false, reason: 'signature_mismatch' };
        }
        return { valid: true };
    }
}
