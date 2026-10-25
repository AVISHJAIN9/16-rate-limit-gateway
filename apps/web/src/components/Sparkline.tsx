import React from 'react';

export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  label?: string;
}

export const Sparkline: React.FC<SparklineProps> = ({
  data,
  width = 280,
  height = 60,
  color = '#6366f1',
  label = 'Throughput Sparkline'
}) => {
  if (data.length < 2) {
    return <div style={{ height, color: 'var(--text-muted)', fontSize: '0.75rem' }}>Awaiting data...</div>;
  }

  const min = Math.min(...data);
  const max = Math.max(...data, min + 1);
  const padding = 5;
  const graphWidth = width - padding * 2;
  const graphHeight = height - padding * 2;

  const points = data.map((val, index) => {
    const x = padding + (index / (data.length - 1)) * graphWidth;
    const y = padding + graphHeight - ((val - min) / (max - min)) * graphHeight;
    return `${x},${y}`;
  });

  const pathD = `M ${points.join(' L ')}`;
  const areaD = `${pathD} L ${width - padding},${height} L ${padding},${height} Z`;

  return (
    <div style={{ position: 'relative', width, height }} role="img" aria-label={label}>
      <svg width={width} height={height} style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id={`sparkline-grad-${color}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.0" />
          </linearGradient>
        </defs>
        <path d={areaD} fill={`url(#sparkline-grad-${color})`} />
        <path d={pathD} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
};
