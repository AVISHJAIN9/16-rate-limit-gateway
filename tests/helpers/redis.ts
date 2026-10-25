import IORedis from 'ioredis';

import { DEFAULT_REDIS_URL } from '../../src/config/index.js';

type RedisClient = {
  connect(): Promise<void>;
  quit(): Promise<void>;
  keys(_pattern: string): Promise<string[]>;
  del(..._keys: string[]): Promise<number>;
};

type RedisCtor = new (_url?: string, _options?: { lazyConnect?: boolean; maxRetriesPerRequest?: number }) => RedisClient;

export async function getRedisClient(prefix: string, url = DEFAULT_REDIS_URL): Promise<{ client: RedisClient; cleanup: () => Promise<void> }> {
  const RedisConstructor = IORedis as unknown as RedisCtor;
  const client = new RedisConstructor(url, { lazyConnect: true, maxRetriesPerRequest: 1 });

  try {
    await client.connect();
  } catch (error) {
    await client.quit().catch(() => undefined);
    throw new Error(`Redis unavailable at ${url}: ${(error as Error).message}`);
  }

  const cleanup = async (): Promise<void> => {
    const keys = await client.keys(`${prefix}:*`);
    if (keys.length > 0) {
      await client.del(...keys);
    }
    await client.quit();
  };

  return { client, cleanup };
}
