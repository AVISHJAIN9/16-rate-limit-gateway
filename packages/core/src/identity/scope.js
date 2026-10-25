function handleMissingDimension(id, p, _dimName) {
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
export class GlobalScopeKeyer {
    extractDimension(_id, _p) {
        return { dimension: 'global' };
    }
}
export class ClientScopeKeyer {
    extractDimension(id, p) {
        if (id.clientId) {
            return { dimension: id.clientId };
        }
        return handleMissingDimension(id, p, 'client_id');
    }
}
export class UserScopeKeyer {
    extractDimension(id, p) {
        if (id.userId) {
            return { dimension: id.userId };
        }
        return handleMissingDimension(id, p, 'user_id');
    }
}
export class IPScopeKeyer {
    extractDimension(id, p) {
        if (id.ip) {
            return { dimension: id.ip };
        }
        return handleMissingDimension(id, p, 'ip');
    }
}
export class RouteScopeKeyer {
    extractDimension(id, p) {
        if (id.route) {
            return { dimension: id.route };
        }
        return handleMissingDimension(id, p, 'route');
    }
}
export class TenantScopeKeyer {
    extractDimension(id, p) {
        if (id.tenant) {
            return { dimension: id.tenant };
        }
        return handleMissingDimension(id, p, 'tenant');
    }
}
export class EndpointGroupScopeKeyer {
    extractDimension(id, p) {
        if (id.group) {
            return { dimension: id.group };
        }
        return handleMissingDimension(id, p, 'group');
    }
}
export class MethodScopeKeyer {
    extractDimension(id, p) {
        const method = id.method?.trim().toUpperCase();
        if (method) {
            return { dimension: method };
        }
        return handleMissingDimension(id, p, 'method');
    }
}
const keyers = {
    global: new GlobalScopeKeyer(),
    client: new ClientScopeKeyer(),
    user: new UserScopeKeyer(),
    ip: new IPScopeKeyer(),
    route: new RouteScopeKeyer(),
    tenant: new TenantScopeKeyer(),
    endpoint_group: new EndpointGroupScopeKeyer(),
    method: new MethodScopeKeyer(),
};
export function getScopeKeyer(scope) {
    const normalized = scope.toLowerCase();
    const keyer = keyers[normalized];
    if (!keyer) {
        throw new Error(`unknown scope "${scope}"`);
    }
    return keyer;
}
