#!/usr/bin/env node
import { IsolationForest, ModelBenchmarkHarness } from '../packages/aiml/src/index.js';

console.log('=== RLGW ML vs Heuristic Benchmark ===');
const forest = new IsolationForest(25, 32, 12345);

// Synthetic dataset
const data = [];
for (let i = 0; i < 50; i++) {
  data.push({
    subjectId: `client_norm_${i}`,
    windowStartMs: 1000 + i * 50,
    requestRate: 2 + Math.random(),
    rejectRatio: 0.01,
    uniqueRoutes: 2,
    costSum: 2,
    meanInterarrivalMs: 500,
    burstiness: 0.1,
    label: 'benign',
    features: [2 + Math.random(), 0.01, 2, 2, 500, 0.1]
  });
}
for (let i = 0; i < 10; i++) {
  data.push({
    subjectId: `client_atk_${i}`,
    windowStartMs: 2000 + i * 20,
    requestRate: 80 + Math.random() * 20,
    rejectRatio: 0.95,
    uniqueRoutes: 20,
    costSum: 150,
    meanInterarrivalMs: 10,
    burstiness: 0.9,
    label: 'attack_burst',
    features: [80 + Math.random() * 20, 0.95, 20, 150, 10, 0.9]
  });
}

forest.fit(data.map((d) => d.features));
const report = ModelBenchmarkHarness.evaluate(data, forest, 12345);

console.log(`Evaluated ${report.datasetSize} samples.`);
console.log(`Heuristic Detection: Precision=${(report.heuristic.precision * 100).toFixed(1)}%, Recall=${(report.heuristic.recall * 100).toFixed(1)}%, F1=${(report.heuristic.f1 * 100).toFixed(1)}%, Latency=${report.heuristic.latencyUs}µs`);
console.log(`Isolation Forest:     Precision=${(report.isolationForest.precision * 100).toFixed(1)}%, Recall=${(report.isolationForest.recall * 100).toFixed(1)}%, F1=${(report.isolationForest.f1 * 100).toFixed(1)}%, Latency=${report.isolationForest.latencyUs}µs`);
console.log(`Recommendation:       ${report.recommendation}`);
console.log('=== ML Benchmark Completed ===');
