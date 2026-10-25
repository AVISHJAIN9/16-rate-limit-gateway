export function isTenantScoped(tenant) {
    if (!tenant)
        return false;
    const t = tenant.trim().toLowerCase();
    return t !== '' && t !== 'global' && t !== '*';
}
/**
 * ComparePriority defines a deterministic strict total order between two matched policies:
 * 1. Explicit Priority descending (higher number = higher priority).
 * 2. Specificity descending (higher specificity = higher priority).
 * 3. Tenant-specific over global.
 * 4. Deterministic Tie-Breaker: Policy ID ascending.
 * 5. Version descending.
 */
export function comparePriority(a, b) {
    // 1. Explicit Priority
    const prioA = a.policy.priority ?? 0;
    const prioB = b.policy.priority ?? 0;
    if (prioA !== prioB) {
        return prioB - prioA; // Higher first
    }
    // 2. Specificity
    if (a.specificity !== b.specificity) {
        return b.specificity - a.specificity; // Higher first
    }
    // 3. Tenant-specific over global
    const aTenant = isTenantScoped(a.policy.tenant);
    const bTenant = isTenantScoped(b.policy.tenant);
    if (aTenant !== bTenant) {
        return aTenant ? -1 : 1;
    }
    // 4. Deterministic Tie-Breaker: ID ascending
    const idComp = a.policy.id.localeCompare(b.policy.id);
    if (idComp !== 0) {
        return idComp;
    }
    // 5. Version descending
    const verA = a.policy.version ?? 1;
    const verB = b.policy.version ?? 1;
    if (verA !== verB) {
        return verB - verA;
    }
    return 0;
}
/**
 * Sorts matched routes in descending precedence according to the strict total order.
 */
export function sortMatchedRoutes(routes) {
    routes.sort(comparePriority);
}
