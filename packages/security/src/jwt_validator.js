import * as jose from 'jose';
export class JWTValidator {
    allowedAlgs;
    constructor(options = {}) {
        this.allowedAlgs = options.allowedAlgorithms ?? ['RS256', 'ES256', 'HS256'];
    }
    async verifyJWT(token, keyOrSecret, options = {}) {
        const rawProtected = jose.decodeProtectedHeader(token);
        const alg = rawProtected.alg;
        // Strict rejection of none and algorithm confusion
        if (!alg || alg.toLowerCase() === 'none' || !this.allowedAlgs.includes(alg)) {
            throw new Error(`Unauthorized or forbidden JWT algorithm: ${alg}`);
        }
        let key;
        if (typeof keyOrSecret === 'string') {
            key = new TextEncoder().encode(keyOrSecret);
        }
        else {
            key = keyOrSecret;
        }
        const verifyOpts = {
            algorithms: this.allowedAlgs,
            clockTolerance: options.clockToleranceSec ?? 60,
        };
        if (options.issuer)
            verifyOpts.issuer = options.issuer;
        if (options.audience)
            verifyOpts.audience = options.audience;
        const { payload } = await jose.jwtVerify(token, key, verifyOpts);
        return {
            sub: payload.sub ?? '',
            clientId: payload.client_id ?? payload.sub ?? '',
            tenant: payload.tenant ?? 'global',
            roles: Array.isArray(payload.roles) ? payload.roles : undefined,
            scopes: Array.isArray(payload.scopes) ? payload.scopes : undefined,
        };
    }
}
