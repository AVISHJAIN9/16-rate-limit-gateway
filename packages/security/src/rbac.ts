export type AdminRole = 'viewer' | 'operator' | 'policy-admin' | 'tenant-admin' | 'super-admin';

export type AdminAction =
  | 'policy:read'
  | 'policy:write'
  | 'policy:delete'
  | 'policy:rollback'
  | 'policy:override'
  | 'audit:read'
  | 'jail:manage'
  | 'admin:manage_users';

export const RolePermissions: Record<AdminRole, Set<AdminAction>> = {
  'viewer': new Set(['policy:read', 'audit:read']),
  'operator': new Set(['policy:read', 'audit:read', 'jail:manage']),
  'policy-admin': new Set(['policy:read', 'policy:write', 'policy:rollback', 'policy:override', 'audit:read']),
  'tenant-admin': new Set(['policy:read', 'policy:write', 'policy:delete', 'policy:rollback', 'policy:override', 'audit:read', 'jail:manage']),
  'super-admin': new Set([
    'policy:read',
    'policy:write',
    'policy:delete',
    'policy:rollback',
    'policy:override',
    'audit:read',
    'jail:manage',
    'admin:manage_users',
  ]),
};

export class RBACAuthorizer {
  static isAuthorized(
    userRoles: string[],
    action: AdminAction,
    userTenant?: string,
    targetTenant?: string
  ): boolean {
    // 1. Tenant boundary check
    const isSuperAdmin = userRoles.includes('super-admin');
    if (!isSuperAdmin && targetTenant && userTenant && targetTenant !== 'global' && userTenant !== targetTenant) {
      return false; // Denied across tenant boundary
    }

    // 2. Action permission check across roles
    for (const r of userRoles) {
      const perms = RolePermissions[r as AdminRole];
      if (perms && perms.has(action)) {
        return true;
      }
    }

    return false; // Deny by default
  }
}
