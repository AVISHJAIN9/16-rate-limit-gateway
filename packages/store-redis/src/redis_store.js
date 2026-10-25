import IORedis from 'ioredis';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MemoryLimiterStore } from '@rlgw/store-memory';
import { HotKeyShield } from './hot_key_shield.js';
import { PipelineBatcher } from './batcher.js';
import { ShardedCounterKeyer } from './sharded_counter.js';
const RedisClass = IORedis.default ?? IORedis;
const RedisClusterClass = IORedis.Cluster ?? IORedis.default?.Cluster;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export class RedisLimiterStore {
    redis;
    replicaClient;
    scripts = new Map();
    fallbackStore;
    hotKeyShield;
    batcher;
    shardedKeyer;
    mode = 'normal';
    scriptFlushReloadsCount = 0;
    evictionDetectedCount = 0;
    inFlightCommands = 0;
    fallbackCount = 0;
    constructor(redisOrOptions) {
        this.fallbackStore = new MemoryLimiterStore();
        if (redisOrOptions && typeof redisOrOptions.evalsha === 'function') {
            this.redis = redisOrOptions;
        }
        else {
            const opts = redisOrOptions || {};
            if (opts.clusterNodes && opts.clusterNodes.length > 0 && RedisClusterClass) {
                this.redis = new RedisClusterClass(opts.clusterNodes, {
                    redisOptions: opts,
                    enableReadyCheck: true,
                    scaleReads: 'all',
                });
            }
            else if (opts.sentinels && opts.sentinels.length > 0) {
                this.redis = new RedisClass({
                    sentinels: opts.sentinels,
                    name: opts.name ?? 'mymaster',
                    commandTimeout: opts.timeoutMs ?? 2000,
                    ...opts,
                });
            }
            else {
                this.redis = new RedisClass({
                    host: opts.host ?? '127.0.0.1',
                    port: opts.port ?? 6379,
                    commandTimeout: opts.timeoutMs ?? 2000,
                    enableOfflineQueue: true,
                    maxRetriesPerRequest: 3,
                    ...opts,
                });
            }
            this.replicaClient = opts.replicaClient;
            if (opts.enableHotKeyShield) {
                this.hotKeyShield = new HotKeyShield();
            }
            if (opts.enableBatching) {
                this.batcher = new PipelineBatcher(async (requests) => {
                    return this.executePipelineBatch(requests);
                });
            }
        }
        const opts = (redisOrOptions && typeof redisOrOptions.evalsha !== 'function')
            ? redisOrOptions
            : {};
        this.shardedKeyer = new ShardedCounterKeyer(opts.shardsCount ?? 1);
        this.loadScripts();
    }
    get client() {
        return this.redis;
    }
    get replica() {
        return this.replicaClient;
    }
    async checkEvictionPolicy(allowUnsafe = false) {
        try {
            const res = await this.redis.config('GET', 'maxmemory-policy');
            const policy = Array.isArray(res) && res.length >= 2 ? String(res[1]) : 'noeviction';
            if (!allowUnsafe && (policy.includes('allkeys-lru') || policy.includes('allkeys-random'))) {
                this.evictionDetectedCount++;
                throw new Error(`Unsafe Redis eviction policy detected: ${policy}. Counters may be silently evicted!`);
            }
            return policy;
        }
        catch (err) {
            if (err.message.includes('Unsafe Redis eviction policy')) {
                throw err;
            }
            return 'unknown';
        }
    }
    async preloadScripts() {
        for (const [, item] of this.scripts.entries()) {
            try {
                const sha = (await this.redis.script('LOAD', item.code));
                item.sha = sha;
            }
            catch (_err) {
                // Ignored during preload if redis is not ready
            }
        }
    }
    async ping() {
        return this.redis.ping();
    }
    loadScripts() {
        const luaDir = path.resolve(__dirname, 'lua');
        const algos = [
            'token_bucket',
            'leaky_bucket',
            'fixed_window',
            'sliding_window_log',
            'sliding_window_counter',
            'gcra',
        ];
        for (const algo of algos) {
            const scriptPath = path.join(luaDir, `${algo}.lua`);
            if (fs.existsSync(scriptPath)) {
                const code = fs.readFileSync(scriptPath, 'utf-8');
                const sha = crypto.createHash('sha1').update(code).digest('hex');
                this.scripts.set(algo, { code, sha });
            }
        }
    }
    async decide(key, spec, cost, nowMs, signal) {
        if (signal?.aborted) {
            throw new Error('Operation aborted');
        }
        // F41: Hot-key local shielding check
        if (this.hotKeyShield) {
            const isHot = this.hotKeyShield.recordAccess(key, cost);
            if (isHot) {
                const shielded = this.hotKeyShield.tryConsumeLocalLease(key, cost, nowMs);
                if (shielded) {
                    return shielded;
                }
            }
        }
        try {
            this.inFlightCommands++;
            const decision = await this.runAlgorithm(key, spec, cost, nowMs, false, signal);
            this.mode = 'normal';
            // Grant new lease if hot
            if (this.hotKeyShield && decision.allowed) {
                this.hotKeyShield.grantLease(key, this.hotKeyShield.maxLeaseBatch, decision, nowMs);
            }
            return decision;
        }
        catch (err) {
            if (this.isConnectionError(err)) {
                return this.handleFallback('decide', key, spec, cost, nowMs);
            }
            throw err;
        }
        finally {
            this.inFlightCommands = Math.max(0, this.inFlightCommands - 1);
        }
    }
    async peek(key, spec, nowMs, cost = 1, signal) {
        if (signal?.aborted) {
            throw new Error('Operation aborted');
        }
        // F35: Micro-batching of peeks
        if (this.batcher) {
            return this.batcher.schedule({ key, spec, nowMs, cost, signal });
        }
        try {
            this.inFlightCommands++;
            // F38: Replica read offloading if available
            const clientToUse = this.replicaClient ?? this.redis;
            const decision = await this.runAlgorithmWithClient(clientToUse, key, spec, cost, nowMs, true);
            this.mode = 'normal';
            return decision;
        }
        catch (err) {
            if (this.isConnectionError(err)) {
                return this.handleFallback('peek', key, spec, cost, nowMs);
            }
            throw err;
        }
        finally {
            this.inFlightCommands = Math.max(0, this.inFlightCommands - 1);
        }
    }
    async commit(key, spec, cost, nowMs, signal) {
        return this.decide(key, spec, cost, nowMs, signal);
    }
    async refund(key, spec, cost, _nowMs) {
        try {
            this.inFlightCommands++;
            await this.executeRefund(key, spec, cost, _nowMs);
        }
        catch (err) {
            if (this.isConnectionError(err)) {
                await this.fallbackStore.refund(key, spec, cost, _nowMs);
                return;
            }
            throw err;
        }
        finally {
            this.inFlightCommands = Math.max(0, this.inFlightCommands - 1);
        }
    }
    async executeRefund(key, spec, cost, _nowMs) {
        switch (spec.type) {
            case 'token_bucket': {
                const data = await this.redis.hmget(key, 'tokens');
                if (data && data[0]) {
                    const current = Number.parseFloat(data[0]);
                    const updated = Math.min(spec.capacity, current + cost);
                    await this.redis.hset(key, 'tokens', updated);
                }
                break;
            }
            case 'leaky_bucket': {
                const data = await this.redis.hmget(key, 'level');
                if (data && data[0]) {
                    const current = Number.parseFloat(data[0]);
                    const updated = Math.max(0, current - cost);
                    await this.redis.hset(key, 'level', updated);
                }
                break;
            }
            case 'fixed_window': {
                const currentWindowStart = Math.floor(_nowMs / spec.windowMs) * spec.windowMs;
                const windowKey = `${key}:${currentWindowStart}`;
                const val = await this.redis.get(windowKey);
                if (val) {
                    const current = Number.parseInt(val, 10);
                    await this.redis.set(windowKey, Math.max(0, current - cost), 'KEEPTTL');
                }
                break;
            }
            case 'sliding_window_counter': {
                const windowStart = Math.floor(_nowMs / spec.windowMs) * spec.windowMs;
                const currKey = `${key}:${windowStart}`;
                const val = await this.redis.get(currKey);
                if (val) {
                    const current = Number.parseInt(val, 10);
                    await this.redis.set(currKey, Math.max(0, current - cost), 'KEEPTTL');
                }
                break;
            }
            case 'gcra': {
                const emissionIntervalMs = 1000 / spec.ratePerSecond;
                const val = await this.redis.get(key);
                if (val) {
                    const currentTat = Number.parseFloat(val);
                    await this.redis.set(key, Math.max(0, currentTat - emissionIntervalMs * cost), 'KEEPTTL');
                }
                break;
            }
        }
    }
    isConnectionError(err) {
        if (!err)
            return false;
        const msg = String(err.message || '').toLowerCase();
        return (msg.includes('connection is closed') ||
            msg.includes('econnrefused') ||
            msg.includes('command timed out') ||
            msg.includes('connection lost') ||
            msg.includes('etimedout') ||
            msg.includes("stream isn't writeable") ||
            msg.includes('not connected') ||
            msg.includes('connection reset') ||
            msg.includes('closed'));
    }
    async handleFallback(operation, key, spec, cost, nowMs) {
        this.mode = 'degraded_local';
        this.fallbackCount++;
        if (operation === 'peek') {
            return this.fallbackStore.peek(key, spec, nowMs, cost);
        }
        return this.fallbackStore.decide(key, spec, cost, nowMs);
    }
    async executePipelineBatch(requests) {
        const pipeline = this.redis.pipeline();
        for (const req of requests) {
            const scriptInfo = this.scripts.get(req.spec.type);
            if (!scriptInfo) {
                throw new Error(`Lua script not found for ${req.spec.type}`);
            }
            const { keys, args } = this.buildScriptArgs(req.key, req.spec, req.cost, req.nowMs, true);
            pipeline.evalsha(scriptInfo.sha, keys.length, ...keys, ...args);
        }
        const results = await pipeline.exec();
        const decisions = [];
        for (let i = 0; i < requests.length; i++) {
            const [err, rawResult] = results[i];
            if (err) {
                // Fallback on single item if needed
                decisions.push(await this.peek(requests[i].key, requests[i].spec, requests[i].nowMs, requests[i].cost));
            }
            else {
                decisions.push({
                    allowed: rawResult[0] === 1,
                    limit: Number(rawResult[1]),
                    remaining: Number(rawResult[2]),
                    resetMs: Number(rawResult[3]),
                    retryAfterMs: Number(rawResult[4]),
                    policyId: requests[i].spec.type,
                    reason: String(rawResult[5]),
                    cost: requests[i].cost,
                    burst: requests[i].spec.capacity ?? Number(rawResult[1]),
                });
            }
        }
        return decisions;
    }
    async runAlgorithm(key, spec, cost, nowMs, peek, signal) {
        return this.runAlgorithmWithClient(this.redis, key, spec, cost, nowMs, peek, signal);
    }
    async runAlgorithmWithClient(client, key, spec, cost, nowMs, peek, signal) {
        if (signal?.aborted) {
            throw new Error('Operation aborted');
        }
        const scriptInfo = this.scripts.get(spec.type);
        if (!scriptInfo) {
            throw new Error(`Lua script not found for algorithm: ${spec.type}`);
        }
        const effectiveKey = this.shardedKeyer.getShardKey(key);
        const { keys, args } = this.buildScriptArgs(effectiveKey, spec, cost, nowMs, peek);
        let rawResult;
        try {
            rawResult = await client.evalsha(scriptInfo.sha, keys.length, ...keys, ...args);
        }
        catch (err) {
            // F36: NOSCRIPT recovery (SCRIPT FLUSH mid-traffic)
            if (err.message && err.message.includes('NOSCRIPT')) {
                this.scriptFlushReloadsCount++;
                const newSha = (await client.script('LOAD', scriptInfo.code));
                scriptInfo.sha = newSha;
                rawResult = await client.evalsha(newSha, keys.length, ...keys, ...args);
            }
            else {
                throw err;
            }
        }
        return {
            allowed: rawResult[0] === 1,
            limit: Number(rawResult[1]),
            remaining: Number(rawResult[2]),
            resetMs: Number(rawResult[3]),
            retryAfterMs: Number(rawResult[4]),
            policyId: spec.type,
            reason: String(rawResult[5]),
            cost,
            burst: spec.capacity ?? Number(rawResult[1]),
        };
    }
    buildScriptArgs(key, spec, cost, nowMs, peek) {
        const peekFlag = peek ? 1 : 0;
        const callerNow = nowMs > 0 ? nowMs : 0;
        switch (spec.type) {
            case 'token_bucket':
                return {
                    keys: [key],
                    args: [cost, callerNow, peekFlag, spec.capacity, spec.refillRate],
                };
            case 'leaky_bucket':
                return {
                    keys: [key],
                    args: [cost, callerNow, peekFlag, spec.capacity, spec.leakRate, spec.variant ?? 'policing'],
                };
            case 'fixed_window':
                return {
                    keys: [key],
                    args: [cost, callerNow, peekFlag, spec.limit, spec.windowMs],
                };
            case 'sliding_window_log':
                return {
                    keys: [key],
                    args: [cost, callerNow, peekFlag, spec.limit, spec.windowMs, spec.maxEntries ?? 10000],
                };
            case 'sliding_window_counter':
                return {
                    keys: [key],
                    args: [cost, callerNow, peekFlag, spec.limit, spec.windowMs],
                };
            case 'gcra':
                return {
                    keys: [key],
                    args: [cost, callerNow, peekFlag, spec.capacity, spec.ratePerSecond],
                };
        }
    }
    async close() {
        if (this.hotKeyShield) {
            this.hotKeyShield.clear();
        }
        if (this.replicaClient) {
            await this.replicaClient.quit();
        }
        await this.redis.quit();
    }
}
