export class SecuritySanitizer {
    static sanitizePath(path) {
        if (!path)
            return '/';
        // 1. Reject NUL bytes
        if (path.includes('\0') || path.includes('%00')) {
            throw new Error('NUL byte detected in path');
        }
        // 2. Reject CRLF injection
        if (/[\r\n]/.test(path) || path.includes('%0d') || path.includes('%0a') || path.includes('%0D') || path.includes('%0A')) {
            throw new Error('CRLF injection detected in path');
        }
        // 3. Reject directory traversal
        const lower = path.toLowerCase();
        if (lower.includes('../') ||
            lower.includes('..\\') ||
            lower.includes('%2e%2e%2f') ||
            lower.includes('%2e%2e/') ||
            lower.includes('..%2f') ||
            lower.includes('%252e%252e%252f') // double encoding
        ) {
            throw new Error('Path traversal detected');
        }
        return path;
    }
    static validateHeaders(headers) {
        const hasCL = headers['content-length'] !== undefined;
        const hasTE = headers['transfer-encoding'] !== undefined;
        // HTTP Request Smuggling protection: conflicting CL and TE
        if (hasCL && hasTE) {
            throw new Error('Conflicting Content-Length and Transfer-Encoding headers detected');
        }
        for (const [k, v] of Object.entries(headers)) {
            if (/[\r\n]/.test(k) || (typeof v === 'string' && /[\r\n]/.test(v))) {
                throw new Error(`CRLF injection detected in header "${k}"`);
            }
        }
    }
    static extractEffectiveMethod(method, headers, allowOverride = false) {
        const base = method.toUpperCase();
        if (!allowOverride)
            return base;
        const override = headers['x-http-method-override'];
        const overrideStr = Array.isArray(override) ? override[0] : override;
        if (overrideStr && typeof overrideStr === 'string') {
            const sanitized = overrideStr.trim().toUpperCase();
            if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(sanitized)) {
                return sanitized;
            }
        }
        return base;
    }
}
