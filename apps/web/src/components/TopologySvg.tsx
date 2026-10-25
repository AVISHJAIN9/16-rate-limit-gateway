import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

export interface TopologyNode {
  id: string;
  role: 'master' | 'replica';
  address: string;
  slots?: string;
  lagMs?: number;
  healthy: boolean;
}

export const TopologySvg: React.FC<{ nodes?: TopologyNode[] }> = ({ nodes: propNodes }) => {
  const [nodes, setNodes] = useState<TopologyNode[]>(propNodes || []);
  const [mode, setMode] = useState<string>('standalone');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (propNodes && propNodes.length > 0) {
      setNodes(propNodes);
      return;
    }
    setLoading(true);
    api.getRedisTopology()
      .then((data) => {
        if (data && data.nodes) {
          setNodes(data.nodes);
          setMode(data.mode || 'standalone');
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [propNodes]);

  const masters = nodes.filter((n) => n.role === 'master');
  const replicas = nodes.filter((n) => n.role === 'replica');

  return (
    <div className="glass-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <div>
          <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>
            F142: Redis Storage Topology ({mode.toUpperCase()})
          </h3>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Real live connection topology reported by the gateway store layer.
          </span>
        </div>
        {loading && <span className="badge badge-warning">Probing...</span>}
      </div>

      {nodes.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', padding: '2rem 0', textAlign: 'center' }}>
          No active Redis nodes reported (In-Memory fallback active).
        </div>
      ) : (
        <svg width="100%" height={Math.max(160, Math.max(masters.length, 1) * 75 + 40)} viewBox="0 0 650 200" style={{ overflow: 'visible' }}>
          {/* Gateway Client Hub */}
          <g transform="translate(30, 70)">
            <rect width="120" height="44" rx="8" fill="#1e1b4b" stroke="#6366f1" strokeWidth="2" />
            <text x="60" y="27" fill="#f9fafb" fontSize="12" fontWeight="600" textAnchor="middle">
              RLGW Gateway
            </text>
          </g>

          {/* Master Nodes */}
          {masters.map((node, i) => {
            const y = 30 + i * 65;
            return (
              <g key={node.id} transform={`translate(220, ${y})`}>
                <line x1="-70" y1={92 - y} x2="0" y2="22" stroke="rgba(99, 102, 241, 0.4)" strokeWidth="1.5" strokeDasharray="3 3" />
                <rect width="180" height="46" rx="8" fill="#111827" stroke={node.healthy ? '#10b981' : '#ef4444'} strokeWidth="1.5" />
                <circle cx="16" cy="23" r="5" fill={node.healthy ? '#10b981' : '#ef4444'} />
                <text x="30" y="20" fill="#f9fafb" fontSize="12" fontWeight="600">
                  {node.id} ({node.role})
                </text>
                <text x="30" y="36" fill="#9ca3af" fontSize="10">
                  {node.address} {node.slots ? `[${node.slots}]` : ''}
                </text>
              </g>
            );
          })}

          {/* Replicas */}
          {replicas.map((replica, i) => {
            const y = 40 + i * 75;
            return (
              <g key={replica.id} transform={`translate(470, ${y})`}>
                <line x1="-70" y1="22" x2="0" y2="22" stroke="rgba(16, 185, 129, 0.3)" strokeWidth="1.5" />
                <rect width="150" height="44" rx="8" fill="#111827" stroke="#059669" strokeWidth="1" strokeDasharray="4 2" />
                <text x="18" y="19" fill="#f9fafb" fontSize="11" fontWeight="500">
                  {replica.id} (Replica)
                </text>
                <text x="18" y="33" fill="#9ca3af" fontSize="9">
                  Lag: {replica.lagMs ?? 0}ms ({replica.address})
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
};
