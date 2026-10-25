import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

export const AnalyticsView: React.FC = () => {
  const [utilization, setUtilization] = useState<{ policyId: string; p50: number; p95: number; max: number }[]>([]);
  const [rejections, setRejections] = useState<Record<string, number>>({});
  const [retryDistribution, setRetryDistribution] = useState<{ bucket: string; count: number }[]>([]);
  const [topOffenders, setTopOffenders] = useState<{ client: string; count: number }[]>([]);
  const [calcCost, setCalcCost] = useState(5);
  const [calcRate, setCalcRate] = useState(10);
  const [calcBurst, setCalcBurst] = useState(20);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function loadData() {
      try {
        setLoading(true);
        const [uData, rData, retryData, topData] = await Promise.all([
          api.getAnalyticsUtilization().catch(() => []),
          api.getAnalyticsRejections().catch(() => ({})),
          api.getAnalyticsRetryAfter().catch(() => []),
          api.getTopClients().catch(() => [])
        ]);

        if (!mounted) return;
        setUtilization(Array.isArray(uData) ? uData : []);
        setRejections(rData || {});
        setRetryDistribution(Array.isArray(retryData) ? retryData : []);
        setTopOffenders(Array.isArray(topData) ? topData : []);
      } catch (err) {
        console.error('Failed to load analytics data', err);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Time until allowed calculator
  const timeUntilAllowed = Math.max(0, (calcCost - calcBurst) / Math.max(1, calcRate)).toFixed(2);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header */}
      <div className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>X11: Gateway Analytics & Quota Telemetry</h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Real-time policy utilization quantiles, rejection breakdown, and client Retry-After distribution.
          </p>
        </div>
        {loading && <span className="badge badge-warning">Refreshing...</span>}
      </div>

      {/* Utilization Quantiles (p50/p95/max per policy) */}
      <div className="glass-card">
        <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>
          Policy Quota Utilization Quantiles (p50 / p95 / Max)
        </h3>
        {utilization.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No active utilization data recorded yet.</div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Policy ID</th>
                  <th>p50 Utilization</th>
                  <th>p95 Utilization</th>
                  <th>Max Peak</th>
                  <th>Saturation Bar</th>
                </tr>
              </thead>
              <tbody>
                {utilization.map((u) => {
                  const p95Pct = Math.min(100, Math.round(u.p95 * 100));
                  return (
                    <tr key={u.policyId}>
                      <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{u.policyId}</td>
                      <td>{(u.p50 * 100).toFixed(1)}%</td>
                      <td>{(u.p95 * 100).toFixed(1)}%</td>
                      <td>{(u.max * 100).toFixed(1)}%</td>
                      <td style={{ minWidth: 160 }}>
                        <div style={{ height: 8, background: '#1e293b', borderRadius: 4, overflow: 'hidden' }}>
                          <div
                            style={{
                              width: `${p95Pct}%`,
                              height: '100%',
                              background: p95Pct > 80 ? '#ef4444' : p95Pct > 50 ? '#f59e0b' : '#10b981',
                              transition: 'width 0.3s'
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Rejections and Top Offenders Grid */}
      <div className="grid-2col">
        {/* 429 Rejections Breakdown */}
        <div className="glass-card">
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>
            Rejections by Reason
          </h3>
          {Object.keys(rejections).length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No rejections observed.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {Object.entries(rejections).map(([reason, count]) => (
                <div key={reason} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.85rem' }} className="badge badge-danger">{reason}</span>
                  <span style={{ fontWeight: 600 }}>{count.toLocaleString()} requests</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top Offenders */}
        <div className="glass-card">
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>
            Top Offending Identities
          </h3>
          {topOffenders.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No throttled clients.</div>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Identity / Client ID</th>
                    <th>Rejected Requests</th>
                  </tr>
                </thead>
                <tbody>
                  {topOffenders.map((top) => (
                    <tr key={top.client}>
                      <td style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>{top.client}</td>
                      <td style={{ fontWeight: 600, color: '#ef4444' }}>{top.count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Retry-After Distribution & Calculator */}
      <div className="grid-2col">
        {/* Retry-After Distribution */}
        <div className="glass-card">
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>
            Retry-After Duration Distribution
          </h3>
          {retryDistribution.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No retry histograms available.</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', height: 140, gap: '1rem', paddingBottom: '1rem' }}>
              {retryDistribution.map((r) => {
                const maxVal = Math.max(...retryDistribution.map(d => d.count), 1);
                const barHeight = Math.max(12, Math.round((r.count / maxVal) * 100));
                return (
                  <div key={r.bucket} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{r.count}</span>
                    <div
                      style={{
                        width: '100%',
                        height: barHeight,
                        background: '#6366f1',
                        borderRadius: '4px 4px 0 0'
                      }}
                    />
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{r.bucket}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Time Until Allowed Calculator */}
        <div className="glass-card">
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            "Time Until Allowed" Calculator
          </h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            Simulate rate-limit recovery time based on required token cost, refill rate, and burst headroom.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Required Cost</label>
                <input
                  type="number"
                  className="input-field"
                  style={{ width: '100%', padding: '0.4rem', marginTop: 4 }}
                  value={calcCost}
                  onChange={(e) => setCalcCost(Number(e.target.value))}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Refill Rate (tokens/s)</label>
                <input
                  type="number"
                  className="input-field"
                  style={{ width: '100%', padding: '0.4rem', marginTop: 4 }}
                  value={calcRate}
                  onChange={(e) => setCalcRate(Number(e.target.value))}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Burst Capacity</label>
                <input
                  type="number"
                  className="input-field"
                  style={{ width: '100%', padding: '0.4rem', marginTop: 4 }}
                  value={calcBurst}
                  onChange={(e) => setCalcBurst(Number(e.target.value))}
                />
              </div>
            </div>

            <div style={{ marginTop: '0.5rem', padding: '0.75rem', background: '#0f172a', borderRadius: 6, border: '1px solid #1e293b' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Computed Wait Time (Retry-After)</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: Number(timeUntilAllowed) > 0 ? '#f59e0b' : '#10b981', marginTop: 2 }}>
                {timeUntilAllowed}s
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
