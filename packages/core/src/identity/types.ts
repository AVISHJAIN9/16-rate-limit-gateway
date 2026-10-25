export interface ResolvedIdentity {
  tenant: string;
  clientId: string;
  apiKeyId?: string;
  userId?: string;
  ip: string;
  route: string; // Route template (e.g. "/users/{id}"), never raw path
  method: string;
  group?: string;
  attributes?: Record<string, string>;
  source: string; // "api_key" | "jwt" | "mtls" | "ip_fallback"
}

export interface ScopeResolutionResult {
  dimension: string;
  skip?: boolean;
  deny?: boolean;
}

export type OnMissingIdentityAction = 'deny' | 'skip' | 'fallback_ip';
