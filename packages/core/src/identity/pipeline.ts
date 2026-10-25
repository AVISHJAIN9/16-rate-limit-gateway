import type { ResolvedIdentity } from './types.js';
import type { KeyLookup, TrustedProxyChecker } from '../types.js';
import { parseAPIKey } from './apikey.js';
import { parseAndNormalizeIP } from './ip.js';
import { UntrustedProxyChecker } from './trusted_proxy.js';

export interface IncomingRequestMeta {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  method: string;
  path: string;
  routeTemplate?: string;
}

export interface IdentitySource {
  readonly name: string;
  resolve(req: IncomingRequestMeta, id: ResolvedIdentity): Promise<boolean>;
}

export class APIKeySource implements IdentitySource {
  readonly name = 'api_key';

  constructor(
    private readonly lookup: KeyLookup,
    private readonly headerName: string = 'x-api-key'
  ) {}

  async resolve(req: IncomingRequestMeta, id: ResolvedIdentity): Promise<boolean> {
    let raw: string | undefined;
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

    if (!raw) return false;

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

export class UserIDSource implements IdentitySource {
  readonly name = 'user_id';

  constructor(
    private readonly headerName: string = 'x-user-id',
    private readonly allowUntrusted: boolean = false
  ) {}

  async resolve(req: IncomingRequestMeta, id: ResolvedIdentity): Promise<boolean> {
    const val = req.headers[this.headerName.toLowerCase()];
    const userStr = Array.isArray(val) ? val[0] : val;
    if (!userStr) return false;

    id.userId = userStr;
    id.source = 'user_id';
    return true;
  }
}

export class ClientIPSource implements IdentitySource {
  readonly name = 'ip';

  constructor(
    private readonly proxyChecker: TrustedProxyChecker = new UntrustedProxyChecker(),
    private readonly ipv6PrefixBits: number = 64
  ) {}

  async resolve(req: IncomingRequestMeta, id: ResolvedIdentity): Promise<boolean> {
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
    } catch {
      id.ip = clientIP;
    }
    return true;
  }
}

export class ResolverPipeline {
  private stages: IdentitySource[] = [];
  private ipSource?: ClientIPSource;

  constructor(stages: IdentitySource[] = [], ipSource?: ClientIPSource) {
    this.stages = stages;
    this.ipSource = ipSource;
  }

  addStage(source: IdentitySource): this {
    if (source.name === 'ip') {
      this.ipSource = source as ClientIPSource;
    } else {
      this.stages.push(source);
    }
    return this;
  }

  setIPSource(ipSource: ClientIPSource): this {
    this.ipSource = ipSource;
    return this;
  }

  async resolve(req: IncomingRequestMeta): Promise<ResolvedIdentity> {
    const id: ResolvedIdentity = {
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
