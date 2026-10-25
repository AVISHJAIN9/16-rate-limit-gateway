import { CIDRProxyChecker, parseAndNormalizeIP } from '@rlgw/core';
export class TrustedProxyVerifier {
    checker;
    constructor(trustedCIDRs = []) {
        this.checker = new CIDRProxyChecker(trustedCIDRs);
    }
    isTrusted(ip) {
        return this.checker.isTrusted(ip);
    }
    /**
     * Evaluates X-Forwarded-For using right-to-left traversal.
     * Walks back through hops; the first untrusted hop is the true client IP.
     */
    verifyForwardedHeader(directRemoteIP, xffHeader) {
        let normalizedDirect = directRemoteIP;
        try {
            normalizedDirect = parseAndNormalizeIP(directRemoteIP);
        }
        catch {
            // Direct IP parse failure, fall back to raw string
        }
        const hopsRaw = Array.isArray(xffHeader) ? xffHeader.join(', ') : xffHeader;
        if (!hopsRaw) {
            return {
                clientIP: normalizedDirect,
                trustedHops: this.isTrusted(normalizedDirect) ? [normalizedDirect] : [],
                untrustedHops: this.isTrusted(normalizedDirect) ? [] : [normalizedDirect],
                spoofAttemptDetected: false,
            };
        }
        const rawList = hopsRaw.split(',').map((s) => s.trim()).filter(Boolean);
        const normalizedHops = [];
        for (const h of rawList) {
            try {
                normalizedHops.push(parseAndNormalizeIP(h));
            }
            catch {
                // Malformed IP in header -> spoofing attempt
                return {
                    clientIP: normalizedDirect,
                    trustedHops: [],
                    untrustedHops: [normalizedDirect],
                    spoofAttemptDetected: true,
                };
            }
        }
        // If direct remote is NOT trusted, ignore header completely
        if (!this.isTrusted(normalizedDirect)) {
            return {
                clientIP: normalizedDirect,
                trustedHops: [],
                untrustedHops: [normalizedDirect],
                spoofAttemptDetected: normalizedHops.length > 0,
            };
        }
        // Right-to-left traversal
        const trustedHops = [normalizedDirect];
        const untrustedHops = [];
        let trueClient = normalizedDirect;
        for (let i = normalizedHops.length - 1; i >= 0; i--) {
            const hop = normalizedHops[i];
            if (this.isTrusted(hop)) {
                trustedHops.push(hop);
            }
            else {
                trueClient = hop;
                for (let j = 0; j <= i; j++) {
                    untrustedHops.push(normalizedHops[j]);
                }
                break;
            }
        }
        return {
            clientIP: trueClient,
            trustedHops,
            untrustedHops,
            spoofAttemptDetected: untrustedHops.length > 1,
        };
    }
    /**
     * Strip untrusted identity headers if caller is not a trusted proxy.
     */
    stripUntrustedHeaders(remoteIP, headers) {
        const isDirectTrusted = this.isTrusted(remoteIP);
        if (isDirectTrusted) {
            return { ...headers };
        }
        const clean = { ...headers };
        delete clean['x-forwarded-for'];
        delete clean['x-forwarded-host'];
        delete clean['x-forwarded-proto'];
        delete clean['x-real-ip'];
        delete clean['x-client-ip'];
        return clean;
    }
}
