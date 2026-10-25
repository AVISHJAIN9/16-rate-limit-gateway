import React from 'react';

export interface Quantiles {
  p50: number;
  p90: number;
  p99: number;
  p999: number;
}

export const LatencyGauge: React.FC<{ quantiles: Quantiles }> = ({ quantiles }) => {
  const items = [
    { label: 'p50 Median', val: quantiles.p50, target: 100, unit: 'µs' },
    { label: 'p90 90th', val: quantiles.p90, target: 500, unit: 'µs' },
    { label: 'p99 SLO (≤2ms)', val: quantiles.p99, target: 2000, unit: 'µs' },
    { label: 'p99.9 Tail', val: quantiles.p999, target: 5000, unit: 'µs' }
  ];

  return (
    <div className="glass-card">
      <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1.25rem' }}>
        Latency Quantiles (Microseconds)
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
        {items.map((item, idx) => {
          const ratio = Math.min(1, item.val / item.target);
          const isHealthy = item.val <= item.target;
          return (
            <div key={idx} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: isHealthy ? '#f9fafb' : '#ef4444' }}>
                {item.val.toFixed(1)} <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{item.unit}</span>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0.25rem 0 0.5rem' }}>
                {item.label}
              </div>
              <div style={{ width: '100%', height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 2 }}>
                <div
                  style={{
                    width: `${ratio * 100}%`,
                    height: '100%',
                    background: isHealthy ? '#6366f1' : '#ef4444',
                    borderRadius: 2,
                    transition: 'width 0.3s ease'
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
