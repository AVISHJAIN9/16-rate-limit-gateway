import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { FakeClock } from '../src/time/clock.js';

const featuresPath = path.join(process.cwd(), 'docs', 'features.json');
const json = JSON.parse(readFileSync(featuresPath, 'utf8')) as { length: number };

describe('batch-00 smoke checks', () => {
  it('advances, sets, and moves backward with the fake clock', () => {
    const clock = new FakeClock(1_000);

    clock.advance(250);
    expect(clock.nowMs()).toBe(1_250);

    clock.set(2_000);
    expect(clock.nowMs()).toBe(2_000);

    clock.jumpBackward(250);
    expect(clock.nowMs()).toBe(1_750);
  });

  it('maintains the expected feature counts', () => {
    expect(json).toHaveLength(150);
    const p0Count = (json as Array<{ priority: string }>).filter((feature) => feature.priority === 'P0').length;
    const p1Count = (json as Array<{ priority: string }>).filter((feature) => feature.priority === 'P1').length;
    const p2Count = (json as Array<{ priority: string }>).filter((feature) => feature.priority === 'P2').length;

    expect(p0Count).toBe(105);
    expect(p1Count).toBe(30);
    expect(p2Count).toBe(15);
  });
});
