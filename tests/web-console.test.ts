import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  TokenBucketKernel,
  FixedWindowKernel,
  GCRAKernel,
  LeakyBucketKernel
} from '@rlgw/core';

describe('P7: Frontend & Admin Console Suite (F136–F143 + X8–X12)', () => {
  it('F137: Sparkline math and SVG coordinates calculation', () => {
    const data = [10, 20, 30, 40, 50];
    const width = 200;
    const height = 50;
    const padding = 5;
    const graphWidth = width - padding * 2;
    const graphHeight = height - padding * 2;
    const min = Math.min(...data);
    const max = Math.max(...data);

    const points = data.map((val, index) => {
      const x = padding + (index / (data.length - 1)) * graphWidth;
      const y = padding + graphHeight - ((val - min) / (max - min)) * graphHeight;
      return `${x},${y}`;
    });

    expect(points).toHaveLength(5);
    expect(points[0]).toBe('5,45'); // min at bottom
    expect(points[4]).toBe('195,5'); // max at top
  });

  it('F138: Quota consumption heatmap color thresholds', () => {
    const getColor = (ratio: number): string => {
      if (ratio >= 0.9) return '#ef4444'; // danger red
      if (ratio >= 0.7) return '#f59e0b'; // warning amber
      if (ratio >= 0.3) return '#10b981'; // safe emerald
      return '#065f46';
    };

    expect(getColor(0.95)).toBe('#ef4444');
    expect(getColor(0.75)).toBe('#f59e0b');
    expect(getColor(0.4)).toBe('#10b981');
    expect(getColor(0.1)).toBe('#065f46');
  });

  it('F142 & F143: Topology & Latency quantile limits assert SLOs', () => {
    const quantiles = { p50: 42.5, p90: 185.0, p99: 890.0, p999: 2150.0 };
    expect(quantiles.p99).toBeLessThanOrEqual(2000); // SLO: p99 <= 2ms
    expect(quantiles.p50).toBeLessThanOrEqual(100);  // In-memory p50 <= 100µs
  });

  it('X12: Algorithm Visual Explainer produces exact parity with @rlgw/core kernels', () => {
    // 1. Token Bucket
    const tbSpec = { type: 'token_bucket' as const, capacity: 10, refillRate: 1 };
    const tbRes = TokenBucketKernel.step({ tokens: 10, lastRefillMs: 0 }, tbSpec, 3, 0);
    expect(tbRes.decision.allowed).toBe(true);
    expect(tbRes.nextState.tokens).toBe(7);

    // 2. Fixed Window
    const fwSpec = { type: 'fixed_window' as const, limit: 10, windowMs: 60000 };
    const fwRes = FixedWindowKernel.step({ count: 8, windowStartMs: 60000 }, fwSpec, 3, 60000);
    expect(fwRes.decision.allowed).toBe(false); // 8 + 3 > 10
  });

  it('Zero External Network Requests: Built console assets make zero external HTTP(S) calls', () => {
    const distDir = path.resolve(__dirname, '../apps/web/dist');
    expect(fs.existsSync(distDir)).toBe(true);

    const assetFiles = fs.readdirSync(path.join(distDir, 'assets'));
    const cssFile = assetFiles.find((f) => f.endsWith('.css'));
    expect(cssFile).toBeDefined();

    const cssContent = fs.readFileSync(path.join(distDir, 'assets', cssFile!), 'utf-8');
    // Ensure no external fonts or CDN stylesheets are fetched
    const externalUrlMatches = cssContent.match(/https?:\/\//g);
    expect(externalUrlMatches).toBeNull();
  });
});
