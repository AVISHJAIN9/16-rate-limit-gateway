export interface CORSPolicy {
  allowedOrigins: string[];
  allowedMethods?: string[];
  allowedHeaders?: string[];
  allowCredentials?: boolean;
  maxAgeSec?: number;
}

export class CORSValidator {
  static evaluate(origin: string | undefined, method: string, policy: CORSPolicy): {
    allowed: boolean;
    headers: Record<string, string>;
  } {
    const headers: Record<string, string> = {};

    if (!origin) {
      return { allowed: true, headers };
    }

    const isWildcard = policy.allowedOrigins.includes('*');
    const isExplicitMatch = policy.allowedOrigins.includes(origin);

    // Rule: Never allow wildcard origin if credentials are requested
    if (policy.allowCredentials && isWildcard) {
      return { allowed: false, headers };
    }

    if (!isWildcard && !isExplicitMatch) {
      return { allowed: false, headers };
    }

    headers['Access-Control-Allow-Origin'] = isWildcard && !policy.allowCredentials ? '*' : origin;
    if (policy.allowCredentials) {
      headers['Access-Control-Allow-Credentials'] = 'true';
    }

    if (method.toUpperCase() === 'OPTIONS') {
      if (policy.allowedMethods) {
        headers['Access-Control-Allow-Methods'] = policy.allowedMethods.join(', ');
      }
      if (policy.allowedHeaders) {
        headers['Access-Control-Allow-Headers'] = policy.allowedHeaders.join(', ');
      }
      if (policy.maxAgeSec) {
        headers['Access-Control-Max-Age'] = policy.maxAgeSec.toString();
      }
    }

    return { allowed: true, headers };
  }
}
