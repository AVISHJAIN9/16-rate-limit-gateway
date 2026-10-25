import React, { useState } from 'react';

export interface HeatmapRow {
  policyId: string;
  buckets: number[]; // ratio 0.0 to 1.0
}

export interface HeatmapProps {
  data: HeatmapRow[];
  timeLabels: string[];
}

export const QuotaHeatmap: React.FC<HeatmapProps> = ({ data, timeLabels }) => {
  const [tooltip, setTooltip] = useState<string | null>(null);

  const getColor = (ratio: number): string => {
    if (ratio >= 0.9) return '#ef4444'; // danger red
    if (ratio >= 0.7) return '#f59e0b'; // warning amber
    if (ratio >= 0.3) return '#10b981'; // safe emerald
    if (ratio > 0) return '#065f46'; // low green
    return 'rgba(255, 255, 255, 0.04)'; // empty
  };

  return (
    <div className="glass-card" style={{ overflowX: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Quota Consumption Heatmap (Policy × Time)</h3>
        {tooltip && <span style={{ fontSize: '0.8rem', color: 'var(--accent-cyan)' }}>{tooltip}</span>}
      </div>

      <table style={{ minWidth: 600 }}>
        <thead>
          <tr>
            <th style={{ width: 140 }}>Policy</th>
            {timeLabels.map((lbl, idx) => (
              <th key={idx} style={{ textAlign: 'center' }}>{lbl}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.policyId}>
              <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{row.policyId}</td>
              {row.buckets.map((val, bIdx) => {
                const pct = Math.round(val * 100);
                return (
                  <td key={bIdx} style={{ padding: '4px', textAlign: 'center' }}>
                    <div
                      tabIndex={0}
                      role="button"
                      aria-label={`${row.policyId} at ${timeLabels[bIdx]}: ${pct}% consumption`}
                      onFocus={() => setTooltip(`${row.policyId} [${timeLabels[bIdx]}]: ${pct}% consumed`)}
                      onMouseEnter={() => setTooltip(`${row.policyId} [${timeLabels[bIdx]}]: ${pct}% consumed`)}
                      onMouseLeave={() => setTooltip(null)}
                      style={{
                        height: 24,
                        borderRadius: 4,
                        background: getColor(val),
                        transition: 'transform 0.1s ease',
                        cursor: 'pointer',
                        outline: 'none'
                      }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
