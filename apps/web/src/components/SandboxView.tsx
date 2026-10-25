import React, { useState } from 'react';
import { TokenBucketKernel } from '@rlgw/core/algorithms';

export const SandboxView: React.FC = () => {
  const [requestsCount, setRequestsCount] = useState(5);
  const [capacity, setCapacity] = useState(10);
  const [refillRate, setRefillRate] = useState(2);
  const [simResults, setSimResults] = useState<Array<{ step: number; allowed: boolean; remaining: number }>>([]);

  const runSimulation = () => {
    let tokens = capacity;
    const results: Array<{ step: number; allowed: boolean; remaining: number }> = [];
    const spec = { type: 'token_bucket' as const, capacity, refillRate };

    for (let i = 1; i <= requestsCount; i++) {
      const now = 1000 + i * 200;
      const res = TokenBucketKernel.step({ tokens, lastRefillMs: now - 200 }, spec, 2, now);
      tokens = res.nextState.tokens;
      results.push({ step: i, allowed: res.decision.allowed, remaining: Math.round(res.decision.remaining) });
    }
    setSimResults(results);
  };

  return (
    <div className="glass-card">
      <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '1rem' }}>
        F140: Policy Simulation Sandbox
      </h3>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        <div>
          <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Capacity</label>
          <input
            type="number"
            value={capacity}
            onChange={(e) => setCapacity(Number(e.target.value))}
            style={{ display: 'block', padding: '6px 10px', background: '#111827', color: '#fff', border: '1px solid var(--border-color)', borderRadius: 4, marginTop: 4 }}
          />
        </div>
        <div>
          <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Refill Rate (/sec)</label>
          <input
            type="number"
            value={refillRate}
            onChange={(e) => setRefillRate(Number(e.target.value))}
            style={{ display: 'block', padding: '6px 10px', background: '#111827', color: '#fff', border: '1px solid var(--border-color)', borderRadius: 4, marginTop: 4 }}
          />
        </div>
        <div>
          <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Burst Steps</label>
          <input
            type="number"
            value={requestsCount}
            onChange={(e) => setRequestsCount(Number(e.target.value))}
            style={{ display: 'block', padding: '6px 10px', background: '#111827', color: '#fff', border: '1px solid var(--border-color)', borderRadius: 4, marginTop: 4 }}
          />
        </div>
        <div style={{ alignSelf: 'flex-end' }}>
          <button className="btn btn-primary" onClick={runSimulation}>Execute Simulation</button>
        </div>
      </div>

      {simResults.length > 0 && (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>Outcome</th>
                <th>Remaining Tokens</th>
              </tr>
            </thead>
            <tbody>
              {simResults.map((r) => (
                <tr key={r.step}>
                  <td>#{r.step}</td>
                  <td>
                    <span className={`badge ${r.allowed ? 'badge-success' : 'badge-danger'}`}>
                      {r.allowed ? 'ALLOWED' : 'DENIED'}
                    </span>
                  </td>
                  <td>{r.remaining}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
