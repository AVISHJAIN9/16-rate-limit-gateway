/**
 * Parse and normalize an IP address.
 * 1. Strips ports and surrounding brackets e.g. [2001:db8::1]:8080 -> 2001:db8::1.
 * 2. Unmaps IPv4-mapped IPv6 addresses (e.g. ::ffff:192.0.2.1 -> 192.0.2.1).
 * 3. Aggregates IPv6 addresses by prefix bits (e.g. /64) to resist address rotation and bound cardinality.
 */
export function parseAndNormalizeIP(raw: string, ipv6PrefixBits: number = 64): string {
  let trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('empty IP address');
  }

  // Handle bracketed IP with port: [2001:db8::1]:8080 or [::ffff:192.0.2.1]:443
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    if (closeIdx === -1) {
      throw new Error(`malformed IP ${raw}: missing closing bracket`);
    }
    const inner = trimmed.slice(1, closeIdx);
    trimmed = inner;
  } else {
    // IPv4 with port e.g. 192.0.2.1:8080 (only single colon)
    const colonCount = (trimmed.match(/:/g) || []).length;
    if (colonCount === 1) {
      const parts = trimmed.split(':');
      trimmed = parts[0];
    }
  }

  // Check IPv4-mapped IPv6 e.g. ::ffff:192.0.2.128 or ::ffff:127.0.0.1
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const after = lower.slice(7);
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(after)) {
      return normalizeIPv4(after);
    }
  }

  // IPv4 standard
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) {
    return normalizeIPv4(trimmed);
  }

  // IPv6 normalization
  return normalizeIPv6(trimmed, ipv6PrefixBits);
}

function normalizeIPv4(ip: string): string {
  const octets = ip.split('.').map(Number);
  for (const oct of octets) {
    if (isNaN(oct) || oct < 0 || oct > 255) {
      throw new Error(`invalid IPv4 address: ${ip}`);
    }
  }
  return octets.join('.');
}

function normalizeIPv6(ip: string, prefixBits: number): string {
  // Expand IPv6 to 8 16-bit hextets
  const hextets = expandIPv6(ip);
  if (prefixBits <= 0 || prefixBits >= 128) {
    return compressIPv6(hextets);
  }

  // Mask by prefix bits
  const fullHextets = Math.floor(prefixBits / 16);
  const remBits = prefixBits % 16;

  const masked = [...hextets];
  if (remBits > 0 && fullHextets < 8) {
    const mask = (0xffff << (16 - remBits)) & 0xffff;
    masked[fullHextets] &= mask;
    for (let i = fullHextets + 1; i < 8; i++) {
      masked[i] = 0;
    }
  } else {
    for (let i = fullHextets; i < 8; i++) {
      masked[i] = 0;
    }
  }

  return compressIPv6(masked);
}

function expandIPv6(ip: string): number[] {
  let lower = ip.toLowerCase();
  // Handle :: compression
  if (lower.includes('::')) {
    const [leftStr, rightStr] = lower.split('::');
    const left = leftStr ? leftStr.split(':') : [];
    const right = rightStr ? rightStr.split(':') : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) {
      throw new Error(`invalid IPv6 address: ${ip}`);
    }
    const middle = new Array(missing).fill('0');
    const parts = [...left, ...middle, ...right];
    return parts.map((h) => parseInt(h || '0', 16));
  }

  const parts = lower.split(':');
  if (parts.length !== 8) {
    throw new Error(`invalid IPv6 address: ${ip}`);
  }
  return parts.map((h) => parseInt(h, 16));
}

function compressIPv6(hextets: number[]): string {
  // Find longest run of zeros for standard RFC 5952 representation
  let maxZeroStart = -1;
  let maxZeroLen = 0;
  let curZeroStart = -1;
  let curZeroLen = 0;

  for (let i = 0; i < 8; i++) {
    if (hextets[i] === 0) {
      if (curZeroStart === -1) {
        curZeroStart = i;
        curZeroLen = 1;
      } else {
        curZeroLen++;
      }
      if (curZeroLen > maxZeroLen) {
        maxZeroStart = curZeroStart;
        maxZeroLen = curZeroLen;
      }
    } else {
      curZeroStart = -1;
      curZeroLen = 0;
    }
  }

  if (maxZeroLen > 1) {
    const left = hextets.slice(0, maxZeroStart).map((h) => h.toString(16));
    const right = hextets.slice(maxZeroStart + maxZeroLen).map((h) => h.toString(16));
    const leftStr = left.join(':');
    const rightStr = right.join(':');
    return `${leftStr}::${rightStr}`;
  }

  return hextets.map((h) => h.toString(16)).join(':');
}
