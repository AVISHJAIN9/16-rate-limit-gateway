#!/usr/bin/env node
import { MemoryLimiterStore } from '../packages/store-memory/src/index.js';

const scale = process.env.RLGW_SCALE || process.env.SCALE || 'smoke';
const count = scale === 'full' ? 500_000 : 50_000;

console.log(`=== RLGW Performance Suite (SCALE=${scale}, operations=${count}) ===`);
const store = new MemoryLimiterStore();

const spec = {
  type: 'token_bucket',
  capacity: 1000,
  refillRate: 500
};

const latenciesNs = [];
const startTotal = process.hrtime.bigint();

for (let i = 0; i < count; i++) {
  const t0 = process.hrtime.bigint();
  await store.decide(`perf_client_${i % 1000}`, spec, 1, 100000 + (i % 1000));
  const t1 = process.hrtime.bigint();
  latenciesNs.push(Number(t1 - t0));
}
const endTotal = process.hrtime.bigint();

latenciesNs.sort((a, b) => a - b);
const p50Us = (latenciesNs[Math.floor(latenciesNs.length * 0.5)] / 1000).toFixed(2);
const p90Us = (latenciesNs[Math.floor(latenciesNs.length * 0.9)] / 1000).toFixed(2);
const p99Us = (latenciesNs[Math.floor(latenciesNs.length * 0.99)] / 1000).toFixed(2);
const totalTimeMs = (Number(endTotal - startTotal) / 1e6).toFixed(2);
const throughputRps = Math.round(count / (Number(endTotal - startTotal) / 1e9));

console.log(`Operations:  ${count}`);
console.log(`Total time:  ${totalTimeMs} ms`);
console.log(`Throughput:  ${throughputRps.toLocaleString()} ops/sec`);
console.log(`Latencies:   p50 = ${p50Us} µs, p90 = ${p90Us} µs, p99 = ${p99Us} µs`);
console.log(`KPI Status:  ${Number(p99Us) <= 100 ? 'PASS (p99 <= 100 µs)' : 'FAIL'}`);
console.log('=== Performance Test Completed ===');
