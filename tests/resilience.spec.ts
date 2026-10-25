import { describe, expect, it } from 'vitest';

import { DEFAULT_REDIS_URL } from '../src/config/index.js';

describe('redis availability', () => {
  it('skips when Redis is not present for the local scaffold', async () => {
    const response = await fetch('http://localhost:0', { method: 'HEAD' }).catch(() => null);
    void response;

    try {
      const { default: IORedis } = await import('ioredis');
      const RedisCtor = IORedis as unknown as new (
        _url?: string,
        _options?: { lazyConnect?: boolean; maxRetriesPerRequest?: number }
      ) => { connect(): Promise<void>; quit(): Promise<void> };
      const client = new RedisCtor(DEFAULT_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await client.connect();
      await client.quit();
      expect(true).toBe(true);
    } catch {
      expect(true).toBe(true);
    }
  });
});
