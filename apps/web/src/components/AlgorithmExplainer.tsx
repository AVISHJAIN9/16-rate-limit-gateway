import React, { useState } from 'react';
import {
  TokenBucketKernel,
  FixedWindowKernel,
  LeakyBucketKernel,
  GCRAKernel
} from '@rlgw/core/algorithms';
import { defaultClock } from '@rlgw/core/clock';

export const AlgorithmExplainer: React.FC = () => {
  const [selectedAlg, setSelectedAlg] = useState<'token_bucket' | 'fixed_window' | 'leaky_bucket' | 'gcra'>('token_bucket');
  const [simCost, setSimCost] = useState(1);
  const [statusMsg, setStatusMsg] = useState('Ready to simulate operations');
  const [tokens, setTokens] = useState(10);
  const capacity = 10;

  const handleSimulate = () => {
    if (selectedAlg === 'token_bucket') {
      const spec = { type: 'token_bucket' as const, capacity, refillRate: 1 };
      const now = defaultClock.nowMs();
      const res = TokenBucketKernel.step({ tokens, lastRefillMs: now - 1000 }, spec, simCost, now);
      setTokens(res.nextState.tokens);
      setStatusMsg(res.decision.allowed ? `Allowed! Remaining: ${res.nextState.tokens.toFixed(1)} tokens` : `Denied! Need ${simCost} tokens but have ${res.nextState.tokens.toFixed(1)}`);
    } else if (selectedAlg === 'fixed_window') {
      const spec = { type: 'fixed_window' as const, limit: 10, windowMs: 60000 };
      const now = defaultClock.nowMs();
      const res = FixedWindowKernel.step({ count: 10 - tokens, windowStartMs: Math.floor(now / 60000) * 60000 }, spec, simCost, now);
      setTokens(Math.max(0, 10 - res.nextState.count));
      setStatusMsg(res.decision.allowed ? `Allowed! Remaining in window: ${res.decision.remaining}` : `Denied! Window limit exceeded`);
    } else if (selectedAlg === 'leaky_bucket') {
      const spec = { type: 'leaky_bucket' as const, capacity: 10, leakRate: 1 };
      const now = defaultClock.nowMs();
      const res = LeakyBucketKernel.step({ level: 10 - tokens, lastLeakMs: now - 1000 }, spec, simCost, now);
      setTokens(Math.max(0, 10 - res.nextState.level));
      setStatusMsg(res.decision.allowed ? `Allowed! Current level: ${res.nextState.level.toFixed(1)}` : `Denied! Bucket overflow`);
    } else if (selectedAlg === 'gcra') {
      const spec = { type: 'gcra' as const, capacity: 10, ratePerSecond: 1 };
      const now = defaultClock.nowMs();
      const res = GCRAKernel.step({ tatMs: now }, spec, simCost, now);
      setStatusMsg(res.decision.allowed ? `Allowed via GCRA! TAT offset: ${Math.max(0, res.nextState.tatMs - now)}ms` : `Denied via GCRA! Cell arrival out of tolerance`);
    } else {
      setStatusMsg(`Simulation computed for ${selectedAlg}`);
    }
  };

  const handleReset = () => {
    setTokens(10);
    setStatusMsg('State reset to capacity 10');
  };

  return (
    <div className="glass-card">
      <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '1rem' }}>
        X12: Interactive Rate Limit Algorithm Visualizer
      </h3>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
        {(['token_bucket', 'fixed_window', 'leaky_bucket', 'gcra'] as const).map((alg) => (
          <button
            key={alg}
            onClick={() => { setSelectedAlg(alg); handleReset(); }}
            className={`btn ${selectedAlg === alg ? 'btn-primary' : 'btn-secondary'}`}
          >
            {alg.replace('_', ' ').toUpperCase()}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', alignItems: 'center' }}>
        <div>
          <div style={{ marginBottom: '1rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            <strong>Capacity:</strong> {capacity} tokens &nbsp;|&nbsp;
            <strong>Cost:</strong>
            <input
              type="number"
              min="1"
              max="10"
              value={simCost}
              onChange={(e) => setSimCost(Number(e.target.value))}
              style={{ width: 50, marginLeft: 8, padding: 4, background: '#111827', color: '#fff', border: '1px solid var(--border-color)', borderRadius: 4 }}
            />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn btn-primary" onClick={handleSimulate}>Simulate Request</button>
            <button className="btn btn-secondary" onClick={handleReset}>Reset Bucket</button>
          </div>
          <p style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--accent-cyan)' }}>{statusMsg}</p>
        </div>

        {/* Visual Token Fill Animation */}
        <div style={{ textAlign: 'center', background: 'rgba(0,0,0,0.2)', padding: '1.5rem', borderRadius: 8 }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Bucket Waterline / Tokens</div>
          <div style={{ width: 80, height: 120, border: '2px solid #6366f1', borderRadius: '0 0 16px 16px', margin: '0 auto', position: 'relative', overflow: 'hidden' }}>
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: `${(tokens / capacity) * 100}%`,
                background: 'linear-gradient(to top, #4f46e5, #06b6d4)',
                transition: 'height 0.25s ease'
              }}
            />
          </div>
          <div style={{ marginTop: '0.5rem', fontSize: '1rem', fontWeight: 600 }}>{tokens.toFixed(1)} / {capacity}</div>
        </div>
      </div>
    </div>
  );
};
