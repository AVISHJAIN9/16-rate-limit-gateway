import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const featuresFile = path.join(root, 'docs', 'features.json');
const featuresMd = path.join(root, 'FEATURES.md');

const json = JSON.parse(readFileSync(featuresFile, 'utf8'));
const markdown = readFileSync(featuresMd, 'utf8');
const tableRows = markdown
  .split('\n')
  .filter((line) => line.startsWith('|') && !line.startsWith('| # |') && !line.startsWith('| ---'));

if (json.length !== 150) {
  throw new Error(`Expected 150 feature rows, found ${json.length}.`);
}

if (tableRows.length !== 150) {
  throw new Error(`Expected 150 feature rows in FEATURES.md, found ${tableRows.length}.`);
}

const p0Count = json.filter((feature) => feature.priority === 'P0').length;
const p1Count = json.filter((feature) => feature.priority === 'P1').length;
const p2Count = json.filter((feature) => feature.priority === 'P2').length;

if (p0Count !== 105 || p1Count !== 30 || p2Count !== 15) {
  throw new Error(`Expected counts P0=105,P1=30,P2=15; found P0=${p0Count},P1=${p1Count},P2=${p2Count}.`);
}

console.log('FEATURES.md and docs/features.json are consistent.');
