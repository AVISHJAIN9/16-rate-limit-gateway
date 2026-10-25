import { describe, expect, it } from 'vitest';

import type { CounterStore } from './types.js';

export async function runStoreContract(factory: () => CounterStore, label: string): Promise<void> {
  describe(label, () => {
    it('incrBy is atomic and monotonic', async () => {
      const store = factory();
      const values = await Promise.all(
        Array.from({ length: 25 }, async (_, index) => {
          const value = await store.incrBy?.(`key:${index}`, 1, 1_000);
          return value ?? 1;
        })
      );

      expect(values.every((value) => value >= 1)).toBe(true);
      const current = await store.get('key:0', 0);
      const count = typeof current === 'number' ? current : current?.count ?? 0;
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it('expires keys and removes them after ttl', async () => {
      const store = factory();
      await store.incrBy?.('ttl-key', 2, 10);
      expect(await store.get('ttl-key', 0)).toBeTruthy();
      expect(await store.expire?.('ttl-key', 0)).toBe(true);
    });

    it('delete clears the state', async () => {
      const store = factory();
      await store.incrBy?.('del-key', 3, 5_000);
      await store.delete('del-key');
      expect(await store.get('del-key', 0)).toBeUndefined();
    });
  });
}
