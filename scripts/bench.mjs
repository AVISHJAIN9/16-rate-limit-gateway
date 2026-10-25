import os from 'node:os';
import { MemoryLimiterStore } from '@rlgw/store-memory';
import { SystemClock } from '@rlgw/core';

async function runBenchmark() {
  console.log('--- RLGW In-Memory Decision Latency Benchmark ---');
  console.log(`OS: ${os.type()} ${os.release()} (${os.arch()})`);
  console.log(`CPUs: ${os.cpus()[0]?.model} (${os.cpus().length} cores)`);
  console.log(`Node: ${process.version}`);

  const store = new MemoryLimiterStore();
  const clock = new SystemClock();
  const iterations = 50000;
  const latenciesUs = new Float64Array(iterations);

  const spec = {
    type: 'token_bucket',
    capacity: 1000000,
    refillRate: 1000000,
    burst: 1000000
  };

  // Warmup
  for (let i = 0; i < 5000; i++) {
    await store.decide('bench:warmup', spec, 1, clock.nowMs());
  }

  // Measurement
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    await store.decide(`bench:key:${i % 100}`, spec, 1, clock.nowMs());
    const end = process.hrtime.bigint();
    latenciesUs[i] = Number(end - start) / 1000; // microseconds
  }

  latenciesUs.sort();
  const p50 = latenciesUs[Math.floor(iterations * 0.50)];
  const p90 = latenciesUs[Math.floor(iterations * 0.90)];
  const p99 = latenciesUs[Math.floor(iterations * 0.99)];
  const p999 = latenciesUs[Math.floor(iterations * 0.999)];

  console.log(`Operations: ${iterations}`);
  console.log(`Latency p50:  ${p50.toFixed(2)} µs`);
  console.log(`Latency p90:  ${p90.toFixed(2)} µs`);
  console.log(`Latency p99:  ${p99.toFixed(2)} µs`);
  console.log(`Latency p99.9: ${p999.toFixed(2)} µs`);

  const passed = p99 <= 100;
  console.log(`KPI p99 <= 100 µs: ${passed ? 'PASS' : 'WARN (measured: ' + p99.toFixed(2) + ' µs)'}`);
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
