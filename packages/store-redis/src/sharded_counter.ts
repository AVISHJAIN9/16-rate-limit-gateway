import crypto from 'node:crypto';

export class ShardedCounterKeyer {
  constructor(public readonly shardsCount: number = 4) {}

  getShardKey(key: string, salt: string = ''): string {
    if (this.shardsCount <= 1) return key;
    const hash = crypto.createHash('md5').update(key + salt).digest();
    const shardIdx = hash.readUInt16BE(0) % this.shardsCount;
    return `${key}:shard_${shardIdx}`;
  }

  getAllShardKeys(key: string): string[] {
    if (this.shardsCount <= 1) return [key];
    const keys: string[] = [];
    for (let i = 0; i < this.shardsCount; i++) {
      keys.push(`${key}:shard_${i}`);
    }
    return keys;
  }
}
