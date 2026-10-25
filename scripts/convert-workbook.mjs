import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const docsDir = path.join(rootDir, 'docs');
mkdirSync(docsDir, { recursive: true });

const sourceWorkbook = path.join(rootDir, 'spreadsheets', 'rate-limit-gateway-spec.xlsx');
const targetWorkbook = path.join(docsDir, '16_Rate_Limit_Gateway_ULTIMATE_150_Master.xlsx');

if (existsSync(sourceWorkbook) && !existsSync(targetWorkbook)) {
  copyFileSync(sourceWorkbook, targetWorkbook);
}

const batchMap = {
  1: Array.from({ length: 8 }, (_, index) => index + 1),
  2: [30, 24, 16, 23, 17, 21],
  3: [25, 26, 27, 18, 19, 20, 22, 29, 28],
  4: Array.from({ length: 7 }, (_, index) => index + 9),
  5: [32, 31, 39, 40, 35, 34, 36],
  6: [33, 37, 38, ...Array.from({ length: 5 }, (_, index) => 41 + index)],
  7: Array.from({ length: 7 }, (_, index) => 46 + index),
  8: Array.from({ length: 8 }, (_, index) => 53 + index),
  9: [61, 65, 64, 63, 62, 66, 67, 68],
  10: Array.from({ length: 7 }, (_, index) => 69 + index),
  11: [109, 110, 111, 106, 107, 108, 117],
  12: [113, 112, 114, 116, 115, 118, 119, 120],
  13: [122, 123, 127, 128, 129, 125, 126],
  14: [130, 121, 124, 131, 132, 135, 133, 134],
  P1: Array.from({ length: 5 }, (_, index) => 15 + index),
  P2: Array.from({ length: 4 }, (_, index) => 20 + index)
};

const featureNames = Array.from({ length: 150 }, (_, index) => `Feature ${index + 1}`);
const features = featureNames.map((name, index) => {
  const id = index + 1;
  const priority = id <= 105 ? 'P0' : id <= 135 ? 'P1' : 'P2';
  const area = ['identity', 'policy', 'algorithms', 'gateway', 'security', 'redis'][id % 6];
  const layers = ['identity', 'policy', 'gateway'];

  let batch = 'TBD';
  for (const [batchKey, ids] of Object.entries(batchMap)) {
    if (ids.includes(id)) {
      batch = batchKey;
      break;
    }
  }

  return {
    id,
    name,
    priority,
    area,
    layers,
    batch
  };
});

const output = JSON.stringify(features, null, 2) + '\n';
writeFileSync(path.join(docsDir, 'features.json'), output, 'utf8');
console.log(`Wrote ${features.length} features to docs/features.json`);
