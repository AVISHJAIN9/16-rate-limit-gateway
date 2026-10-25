import { parseAPIKey } from './apikey.js';
import { parseAndNormalizeIP } from './ip.js';
import { UntrustedProxyChecker } from './trusted_proxy.js';
export class APIKeySource {
    lookup;
    headerName;
    name = 'api_key';
    constructor(lookup, headerName = 'x-api-key') {
        this.lookup = lookup;
        this.headerName = headerName;
    }
    async resolve(req, id) {
        let raw;
        const headerVal = req.headers[this.headerName.toLowerCase()];
        if (headerVal) {
            raw = Array.isArray(headerVal) ? headerVal[0] : headerVal;
        }
        if (!raw) {
            const auth = req.headers['authorization'];
            const authStr = Array.isArray(auth) ? auth[0] : auth;
            if (authStr?.startsWith('Bearer rlk_')) {
                raw = authStr.slice(7);
            }
        }
        if (!raw)
            return false;
        const parsed = parseAPIKey(raw);
        const meta = await this.lookup.lookup(parsed.keyId);
        if (!meta) {
            throw new Error(`API key ${parsed.keyId} not found`);
        }
        id.apiKeyId = meta.keyId;
        id.clientId = meta.clientId ?? meta.keyId;
        id.tenant = meta.tenant ?? 'global';
        id.source = 'api_key';
        return true;
    }
}
export class UserIDSource {
    headerName;
    allowUntrusted;
    name = 'user_id';
    constructor(headerName = 'x-user-id', allowUntrusted = false) {
        this.headerName = headerName;
        this.allowUntrusted = allowUntrusted;
    }
    async resolve(req, id) {
        const val = req.headers[this.headerName.toLowerCase()];
        const userStr = Array.isArray(val) ? val[0] : val;
        if (!userStr)
            return false;
        id.userId = userStr;
        id.source = 'user_id';
        return true;
    }
}
export class ClientIPSource {
    proxyChecker;
    ipv6PrefixBits;
    name = 'ip';
    constructor(proxyChecker = new UntrustedProxyChecker(), ipv6PrefixBits = 64) {
        this.proxyChecker = proxyChecker;
        this.ipv6PrefixBits = ipv6PrefixBits;
    }
    async resolve(req, id) {
        const directIP = req.ip || '127.0.0.1';
        let clientIP = directIP;
        if (this.proxyChecker.isTrusted(directIP)) {
            const xff = req.headers['x-forwarded-for'];
            const xffStr = Array.isArray(xff) ? xff[0] : xff;
            if (xffStr) {
                // Walk right-to-left
                const hops = xffStr.split(',').map((h) => h.trim());
                let selected = hops[hops.length - 1];
                for (let i = hops.length - 1; i >= 0; i--) {
                    if (!this.proxyChecker.isTrusted(hops[i])) {
                        selected = hops[i];
                        break;
                    }
                }
                clientIP = selected;
            }
        }
        try {
            id.ip = parseAndNormalizeIP(clientIP, this.ipv6PrefixBits);
        }
        catch {
            id.ip = clientIP;
        }
        return true;
    }
}
export class ResolverPipeline {
    stages = [];
    ipSource;
    constructor(stages = [], ipSource) {
        this.stages = stages;
        this.ipSource = ipSource;
    }
    addStage(source) {
        if (source.name === 'ip') {
            this.ipSource = source;
        }
        else {
            this.stages.push(source);
        }
        return this;
    }
    setIPSource(ipSource) {
        this.ipSource = ipSource;
        return this;
    }
    async resolve(req) {
        const id = {
            tenant: 'global',
            clientId: '',
            ip: '',
            route: req.routeTemplate || req.path,
            method: req.method,
            source: '',
        };
        let matched = false;
        for (const stage of this.stages) {
            const m = await stage.resolve(req, id);
            if (m) {
                matched = true;
                break;
            }
        }
        if (this.ipSource) {
            await this.ipSource.resolve(req, id);
        }
        if (!matched && !id.source && id.ip) {
            id.source = 'ip_fallback';
        }
        return id;
    }
}
