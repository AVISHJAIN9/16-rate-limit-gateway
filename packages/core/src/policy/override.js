export const DefaultMaxRelaxFactor = 2.0;
export function validateRelaxation(orig, ov, maxRelaxFactor = DefaultMaxRelaxFactor) {
    if (ov.forceRelax) {
        return;
    }
    const factor = maxRelaxFactor <= 1.0 ? DefaultMaxRelaxFactor : maxRelaxFactor;
    // Check limit relaxation in params
    const origParams = orig.params;
    const origLimit = origParams?.limit ?? origParams?.capacity ?? 0;
    if (ov.limit !== undefined && ov.limit > 0 && origLimit > 0) {
        const maxAllowed = Math.floor(origLimit * factor);
        if (ov.limit > maxAllowed) {
            throw new Error(`override limit ${ov.limit} exceeds max relaxation factor ${factor.toFixed(1)}x (max allowed ${maxAllowed}) without force_relax`);
        }
    }
    if (ov.burst !== undefined && ov.burst > 0 && origLimit > 0) {
        const maxAllowed = Math.floor(origLimit * factor);
        if (ov.burst > maxAllowed) {
            throw new Error(`override burst ${ov.burst} exceeds max relaxation factor ${factor.toFixed(1)}x (max allowed ${maxAllowed}) without force_relax`);
        }
    }
}
export function isOverrideActive(ov, nowMs) {
    if (ov.revoked)
        return false;
    if (ov.expiresAtMs !== undefined && nowMs >= ov.expiresAtMs) {
        return false;
    }
    return true;
}
export function applyActiveOverride(p, ov, nowMs) {
    if (!isOverrideActive(ov, nowMs)) {
        return { policy: p, applied: false };
    }
    const updated = {
        ...p,
        params: { ...p.params },
    };
    let applied = false;
    if (ov.limit !== undefined && ov.limit > 0) {
        const params = updated.params;
        if (params.limit !== undefined)
            params.limit = ov.limit;
        if (params.capacity !== undefined)
            params.capacity = ov.limit;
        applied = true;
    }
    if (ov.burst !== undefined && ov.burst > 0) {
        const params = updated.params;
        if (params.capacity !== undefined)
            params.capacity = ov.burst;
        applied = true;
    }
    return { policy: updated, applied };
}
