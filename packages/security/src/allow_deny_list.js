import { CIDRProxyChecker, defaultClock } from '@rlgw/core';
export class AccessListManager {
    denylist = new Map();
    allowlist = new Map();
    deniedCIDRs = [];
    allowedCIDRs = [];
    addToDenylist(entry) {
        const k = `${entry.type}:${entry.value}`;
        this.denylist.set(k, entry);
        if (entry.type === 'cidr') {
            this.deniedCIDRs.push(entry.value);
        }
    }
    addToAllowlist(entry) {
        const k = `${entry.type}:${entry.value}`;
        this.allowlist.set(k, entry);
        if (entry.type === 'cidr') {
            this.allowedCIDRs.push(entry.value);
        }
    }
    isDenied(subject, nowMs = defaultClock.nowMs()) {
        // 1. Check IP in denied CIDRs
        if (subject.ip && this.deniedCIDRs.length > 0) {
            const checker = new CIDRProxyChecker(this.deniedCIDRs);
            if (checker.isTrusted(subject.ip)) {
                return { denied: true, reason: 'ip_cidr_denylisted' };
            }
        }
        // 2. Check exact values
        const checks = [
            `client:${subject.clientId}`,
            `key:${subject.keyId}`,
            `tenant:${subject.tenant}`,
        ];
        for (const c of checks) {
            const entry = this.denylist.get(c);
            if (entry) {
                if (!entry.expiresAtMs || nowMs < entry.expiresAtMs) {
                    return { denied: true, reason: entry.reason ?? 'subject_denylisted' };
                }
            }
        }
        return { denied: false };
    }
    isAllowlisted(subject, nowMs = defaultClock.nowMs()) {
        if (subject.ip && this.allowedCIDRs.length > 0) {
            const checker = new CIDRProxyChecker(this.allowedCIDRs);
            if (checker.isTrusted(subject.ip)) {
                return true;
            }
        }
        const checks = [
            `client:${subject.clientId}`,
            `key:${subject.keyId}`,
            `tenant:${subject.tenant}`,
        ];
        for (const c of checks) {
            const entry = this.allowlist.get(c);
            if (entry && (!entry.expiresAtMs || nowMs < entry.expiresAtMs)) {
                return true;
            }
        }
        return false;
    }
    add(entry) {
        const value = entry.clientId ?? entry.cidr ?? entry.tenant ?? '';
        const itemType = entry.clientId ? 'client' : entry.cidr ? 'cidr' : 'tenant';
        const listEntry = {
            type: itemType,
            value,
            reason: entry.reason,
            expiresAtMs: entry.expiresAt
        };
        if (entry.type === 'allow') {
            this.addToAllowlist(listEntry);
        }
        else {
            this.addToDenylist(listEntry);
        }
        return listEntry;
    }
    listAllowlist() {
        return Array.from(this.allowlist.values());
    }
    listDenylist() {
        return Array.from(this.denylist.values());
    }
    removeFromAllowlist(target) {
        for (const [k, v] of this.allowlist.entries()) {
            if (v.value === target || k === target) {
                this.allowlist.delete(k);
            }
        }
        this.allowedCIDRs = this.allowedCIDRs.filter((c) => c !== target);
    }
    removeFromDenylist(target) {
        for (const [k, v] of this.denylist.entries()) {
            if (v.value === target || k === target) {
                this.denylist.delete(k);
            }
        }
        this.deniedCIDRs = this.deniedCIDRs.filter((c) => c !== target);
    }
    clear() {
        this.denylist.clear();
        this.allowlist.clear();
        this.deniedCIDRs = [];
        this.allowedCIDRs = [];
    }
}
export { AccessListManager as AllowDenyListManager };
