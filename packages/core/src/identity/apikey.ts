import type { KeyLookup } from '../types.js';

export interface ParsedAPIKey {
  keyId: string;
  secret: string;
  clientId?: string;
  tenant?: string;
}

/**
 * Parses raw API key with format "rlk_<keyid>_<secret>".
 * Rejects invalid prefixes, malformed segments, or additional underscores.
 */
export function parseAPIKey(raw: string): ParsedAPIKey {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('rlk_')) {
    throw new Error("api key must begin with prefix 'rlk_'");
  }

  const rest = trimmed.slice(4);
  const idx = rest.indexOf('_');
  if (idx <= 0 || idx === rest.length - 1) {
    throw new Error("api key format must be 'rlk_<keyid>_<secret>'");
  }

  // Ensure no additional underscores in secret
  if (rest.indexOf('_', idx + 1) !== -1) {
    throw new Error("api key format must be 'rlk_<keyid>_<secret>'");
  }

  const keyId = rest.slice(0, idx);
  const secret = rest.slice(idx + 1);

  return { keyId, secret };
}

/**
 * Guarantee the API key secret is NEVER leaked in logs or error messages.
 */
export function redactAPIKey(key: ParsedAPIKey | string): string {
  if (typeof key === 'string') {
    try {
      const parsed = parseAPIKey(key);
      return `rlk_${parsed.keyId}_***REDACTED***`;
    } catch {
      return 'rlk_***REDACTED***';
    }
  }
  if (!key.keyId) {
    return 'rlk_***REDACTED***';
  }
  return `rlk_${key.keyId}_***REDACTED***`;
}

export class InMemoryKeyLookup implements KeyLookup {
  private keys = new Map<string, ParsedAPIKey>();

  registerKey(key: ParsedAPIKey): void {
    this.keys.set(key.keyId, key);
  }

  async lookup(keyId: string): Promise<ParsedAPIKey | null> {
    return this.keys.get(keyId) ?? null;
  }
}
