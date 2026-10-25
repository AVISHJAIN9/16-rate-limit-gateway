export class UntrustedProxyChecker {
    isTrusted(_ip) {
        return false;
    }
}
export class CIDRProxyChecker {
    cidrs;
    constructor(cidrs = []) {
        this.cidrs = cidrs;
    }
    isTrusted(ip) {
        if (this.cidrs.length === 0)
            return false;
        for (const cidr of this.cidrs) {
            if (cidr === ip || cidr === '0.0.0.0/0' || cidr === '::/0') {
                return true;
            }
            if (matchCIDR(ip, cidr)) {
                return true;
            }
        }
        return false;
    }
}
function matchCIDR(ip, cidr) {
    if (!cidr.includes('/'))
        return ip === cidr;
    const [range, bitsStr] = cidr.split('/');
    const prefix = parseInt(bitsStr, 10);
    // IPv4 simple bit check
    if (ip.includes('.') && range.includes('.')) {
        const ipInt = ipToUInt32(ip);
        const rangeInt = ipToUInt32(range);
        const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
        return (ipInt & mask) === (rangeInt & mask);
    }
    return false;
}
function ipToUInt32(ip) {
    return ip.split('.').reduce((acc, oct) => ((acc << 8) + parseInt(oct, 10)) >>> 0, 0);
}
