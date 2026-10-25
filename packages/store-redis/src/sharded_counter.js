import crypto from 'node:crypto';
export class ShardedCounterKeyer {
    shardsCount;
    constructor(shardsCount = 4) {
        this.shardsCount = shardsCount;
    }
    getShardKey(key, salt = '') {
        if (this.shardsCount <= 1)
            return key;
        const hash = crypto.createHash('md5').update(key + salt).digest();
        const shardIdx = hash.readUInt16BE(0) % this.shardsCount;
        return `${key}:shard_${shardIdx}`;
    }
    getAllShardKeys(key) {
        if (this.shardsCount <= 1)
            return [key];
        const keys = [];
        for (let i = 0; i < this.shardsCount; i++) {
            keys.push(`${key}:shard_${i}`);
        }
        return keys;
    }
}
