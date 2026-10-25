export interface NormalizerOptions {
  stripTrailingSlash?: boolean;
  lowercase?: boolean;
}

export class RouteNormalizer {
  /**
   * Normalizes an HTTP URL path into canonical form:
   * 1. Rejects NUL bytes and invalid sequences.
   * 2. Decodes unreserved URI characters only (RFC 3986: A-Z, a-z, 0-9, '-', '_', '.', '~').
   * 3. Resolves dot segments ('.' and '..').
   * 4. Collapses duplicate slashes.
   * 5. Applies trailing-slash and case policies.
   */
  static normalize(rawPath: string, options: NormalizerOptions = {}): string {
    if (!rawPath || typeof rawPath !== 'string') {
      return '/';
    }

    // Reject raw NUL characters
    if (rawPath.includes('\0') || rawPath.toLowerCase().includes('%00')) {
      throw new Error('Invalid path: null byte detected');
    }

    // Split path and query/hash
    let path = rawPath.split(/[?#]/)[0];

    // Decode unreserved percent-encoded characters only
    path = path.replace(/%([0-9a-fA-F]{2})/g, (match, hex) => {
      const code = Number.parseInt(hex, 16);
      // Unreserved characters RFC 3986:
      // 0-9: 0x30-0x39
      // A-Z: 0x41-0x5A
      // a-z: 0x61-0x7A
      // '-': 0x2D, '.': 0x2E, '_': 0x5F, '~': 0x7E
      if (
        (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        code === 0x2d ||
        code === 0x2e ||
        code === 0x5f ||
        code === 0x7e
      ) {
        return String.fromCharCode(code);
      }
      return match.toUpperCase();
    });

    // Collapse duplicate slashes
    path = path.replace(/\/+/g, '/');

    // Resolve dot segments: . and ..
    const segments = path.split('/');
    const resolved: string[] = [];
    for (const segment of segments) {
      if (segment === '' || segment === '.') {
        continue;
      }
      if (segment === '..') {
        if (resolved.length > 0) {
          resolved.pop();
        }
      } else {
        resolved.push(segment);
      }
    }

    const hasTrailingSlash = path.length > 1 && path.endsWith('/');
    let canonical = '/' + resolved.join('/');

    if (hasTrailingSlash && !options.stripTrailingSlash) {
      if (!canonical.endsWith('/')) {
        canonical += '/';
      }
    }

    if (options.lowercase) {
      canonical = canonical.toLowerCase();
    }

    if (options.stripTrailingSlash && canonical.length > 1 && canonical.endsWith('/')) {
      canonical = canonical.slice(0, -1);
    }

    return canonical;
  }
}
