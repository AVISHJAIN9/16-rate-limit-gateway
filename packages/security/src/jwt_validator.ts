import * as jose from 'jose';

export interface JWTValidationOptions {
  issuer?: string;
  audience?: string;
  clockToleranceSec?: number;
  allowedAlgorithms?: string[];
}

export interface JWTClaimsIdentity {
  sub: string;
  clientId: string;
  tenant: string;
  roles?: string[];
  scopes?: string[];
}

export class JWTValidator {
  private allowedAlgs: string[];

  constructor(options: JWTValidationOptions = {}) {
    this.allowedAlgs = options.allowedAlgorithms ?? ['RS256', 'ES256', 'HS256'];
  }

  async verifyJWT(
    token: string,
    keyOrSecret: string | Uint8Array,
    options: JWTValidationOptions = {}
  ): Promise<JWTClaimsIdentity> {
    const rawProtected = jose.decodeProtectedHeader(token);
    const alg = rawProtected.alg;

    // Strict rejection of none and algorithm confusion
    if (!alg || alg.toLowerCase() === 'none' || !this.allowedAlgs.includes(alg)) {
      throw new Error(`Unauthorized or forbidden JWT algorithm: ${alg}`);
    }

    let key: Uint8Array | any;
    if (typeof keyOrSecret === 'string') {
      key = new TextEncoder().encode(keyOrSecret);
    } else {
      key = keyOrSecret;
    }

    const verifyOpts: jose.JWTVerifyOptions = {
      algorithms: this.allowedAlgs,
      clockTolerance: options.clockToleranceSec ?? 60,
    };
    if (options.issuer) verifyOpts.issuer = options.issuer;
    if (options.audience) verifyOpts.audience = options.audience;

    const { payload } = await jose.jwtVerify(token, key as any, verifyOpts);

    return {
      sub: payload.sub ?? '',
      clientId: (payload.client_id as string) ?? payload.sub ?? '',
      tenant: (payload.tenant as string) ?? 'global',
      roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : undefined,
      scopes: Array.isArray(payload.scopes) ? (payload.scopes as string[]) : undefined,
    };
  }
}
