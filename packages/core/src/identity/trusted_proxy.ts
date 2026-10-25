import type { TrustedProxyChecker } from '../types.js';

export class UntrustedProxyChecker implements TrustedProxyChecker {
  isTrusted(_ip: string): boolean {
    return false;
  }
}

export class CIDRProxyChecker implements TrustedProxyChecker {
  private cidrs: string[];

  constructor(cidrs: string[] = []) {
    this.cidrs = cidrs;
  }

  isTrusted(ip: string): boolean {
    if (this.cidrs.length === 0) return false;
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

function matchCIDR(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr;
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

function ipToUInt32(ip: string): number {
  return ip.split('.').reduce((acc, oct) => ((acc << 8) + parseInt(oct, 10)) >>> 0, 0);
}
