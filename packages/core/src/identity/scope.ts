import type { ResolvedIdentity, ScopeResolutionResult, OnMissingIdentityAction } from './types.js';

export interface ScopePolicyContext {
  id: string;
  scope: string;
  onMissingIdentity?: OnMissingIdentityAction;
}

export interface ScopeKeyer {
  extractDimension(id: ResolvedIdentity, p: ScopePolicyContext): ScopeResolutionResult;
}

function handleMissingDimension(id: ResolvedIdentity, p: ScopePolicyContext, _dimName: string): ScopeResolutionResult {
  const action = p.onMissingIdentity ?? 'deny';
  switch (action) {
    case 'skip':
      return { dimension: '', skip: true };
    case 'fallback_ip':
      if (id.ip) {
        return { dimension: `ip:${id.ip}` };
      }
      return { dimension: '', deny: true };
    case 'deny':
    default:
      return { dimension: '', deny: true };
  }
}

export class GlobalScopeKeyer implements ScopeKeyer {
  extractDimension(_id: ResolvedIdentity, _p: ScopePolicyContext): ScopeResolutionResult {
    return { dimension: 'global' };
  }
}

export class ClientScopeKeyer implements ScopeKeyer {
  extractDimension(id: ResolvedIdentity, p: ScopePolicyContext): ScopeResolutionResult {
    if (id.clientId) {
      return { dimension: id.clientId };
    }
    return handleMissingDimension(id, p, 'client_id');
  }
}

export class UserScopeKeyer implements ScopeKeyer {
  extractDimension(id: ResolvedIdentity, p: ScopePolicyContext): ScopeResolutionResult {
    if (id.userId) {
      return { dimension: id.userId };
    }
    return handleMissingDimension(id, p, 'user_id');
  }
}

export class IPScopeKeyer implements ScopeKeyer {
  extractDimension(id: ResolvedIdentity, p: ScopePolicyContext): ScopeResolutionResult {
    if (id.ip) {
      return { dimension: id.ip };
    }
    return handleMissingDimension(id, p, 'ip');
  }
}

export class RouteScopeKeyer implements ScopeKeyer {
  extractDimension(id: ResolvedIdentity, p: ScopePolicyContext): ScopeResolutionResult {
    if (id.route) {
      return { dimension: id.route };
    }
    return handleMissingDimension(id, p, 'route');
  }
}

export class TenantScopeKeyer implements ScopeKeyer {
  extractDimension(id: ResolvedIdentity, p: ScopePolicyContext): ScopeResolutionResult {
    if (id.tenant) {
      return { dimension: id.tenant };
    }
    return handleMissingDimension(id, p, 'tenant');
  }
}

export class EndpointGroupScopeKeyer implements ScopeKeyer {
  extractDimension(id: ResolvedIdentity, p: ScopePolicyContext): ScopeResolutionResult {
    if (id.group) {
      return { dimension: id.group };
    }
    return handleMissingDimension(id, p, 'group');
  }
}

export class MethodScopeKeyer implements ScopeKeyer {
  extractDimension(id: ResolvedIdentity, p: ScopePolicyContext): ScopeResolutionResult {
    const method = id.method?.trim().toUpperCase();
    if (method) {
      return { dimension: method };
    }
    return handleMissingDimension(id, p, 'method');
  }
}

const keyers: Record<string, ScopeKeyer> = {
  global: new GlobalScopeKeyer(),
  client: new ClientScopeKeyer(),
  user: new UserScopeKeyer(),
  ip: new IPScopeKeyer(),
  route: new RouteScopeKeyer(),
  tenant: new TenantScopeKeyer(),
  endpoint_group: new EndpointGroupScopeKeyer(),
  method: new MethodScopeKeyer(),
};

export function getScopeKeyer(scope: string): ScopeKeyer {
  const normalized = scope.toLowerCase();
  const keyer = keyers[normalized];
  if (!keyer) {
    throw new Error(`unknown scope "${scope}"`);
  }
  return keyer;
}
