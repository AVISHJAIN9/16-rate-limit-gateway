import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

interface SemanticDiffModalProps {
  policyId: string;
  isOpen: boolean;
  onClose: () => void;
}

export const SemanticDiffModal: React.FC<SemanticDiffModalProps> = ({ policyId, isOpen, onClose }) => {
  const [versions, setVersions] = useState<any[]>([]);
  const [fromVer, setFromVer] = useState<number>(1);
  const [toVer, setToVer] = useState<number>(1);
  const [diffReport, setDiffReport] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !policyId) return;
    api.getPolicyVersions(policyId).then((vList) => {
      setVersions(vList || []);
      if (vList && vList.length > 1) {
        setFromVer(vList[vList.length - 2].version);
        setToVer(vList[vList.length - 1].version);
      } else if (vList && vList.length === 1) {
        setFromVer(vList[0].version);
        setToVer(vList[0].version);
      }
    }).catch(() => {});
  }, [isOpen, policyId]);

  useEffect(() => {
    if (!isOpen || !policyId || fromVer === undefined || toVer === undefined) return;
    setLoading(true);
    api.getPolicyDiff(policyId, fromVer, toVer).then((diff) => {
      setDiffReport(diff);
      setLoading(false);
    }).catch(() => {
      setLoading(false);
    });
  }, [fromVer, toVer, isOpen, policyId]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal-card" style={{ maxWidth: 650 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.2rem', fontWeight: 700 }}>X9: Semantic Policy Diff</h2>
          <button className="btn btn-secondary" onClick={onClose} style={{ padding: '0.25rem 0.5rem' }}>✕</button>
        </div>

        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          Policy: <code>{policyId}</code> — Compares AST configurations between any two immutable versions with field provenance.
        </p>

        {/* Version Pickers */}
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.25rem', background: 'rgba(0,0,0,0.2)', padding: '0.75rem', borderRadius: 6 }}>
          <div>
            <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>From Version:</label>
            <select
              value={fromVer}
              onChange={(e) => setFromVer(Number(e.target.value))}
              style={{ display: 'block', background: '#111827', color: '#fff', border: '1px solid #374151', padding: '0.35rem', borderRadius: 4, marginTop: 4 }}
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>v{v.version} ({v.reason || 'No reason'})</option>
              ))}
            </select>
          </div>

          <div style={{ fontSize: '1.25rem', color: 'var(--text-muted)', paddingTop: '1rem' }}>→</div>

          <div>
            <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>To Version:</label>
            <select
              value={toVer}
              onChange={(e) => setToVer(Number(e.target.value))}
              style={{ display: 'block', background: '#111827', color: '#fff', border: '1px solid #374151', padding: '0.35rem', borderRadius: 4, marginTop: 4 }}
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>v{v.version} ({v.reason || 'No reason'})</option>
              ))}
            </select>
          </div>
        </div>

        {/* Diff Result Table */}
        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>Computing semantic diff...</div>
        ) : diffReport ? (
          <div>
            <div style={{ marginBottom: '0.75rem', fontSize: '0.85rem' }}>
              Status:{' '}
              {diffReport.hasChanges ? (
                <span className="badge badge-warning">{diffReport.changes.length} field changes detected</span>
              ) : (
                <span className="badge badge-success">No structural changes</span>
              )}
            </div>

            {diffReport.changes && diffReport.changes.length > 0 ? (
              <div style={{ maxHeight: 280, overflowY: 'auto', background: '#0b0f19', borderRadius: 6, border: '1px solid #1f2937' }}>
                <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#111827', textAlign: 'left', borderBottom: '1px solid #1f2937' }}>
                      <th style={{ padding: '0.5rem 0.75rem' }}>Field Path</th>
                      <th style={{ padding: '0.5rem 0.75rem' }}>Previous (v{fromVer})</th>
                      <th style={{ padding: '0.5rem 0.75rem' }}>New (v{toVer})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffReport.changes.map((ch: any, idx: number) => (
                      <tr key={idx} style={{ borderBottom: '1px solid #1f2937' }}>
                        <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'monospace', color: '#6366f1' }}>{ch.path}</td>
                        <td style={{ padding: '0.5rem 0.75rem', color: '#f87171', background: 'rgba(239, 68, 68, 0.05)' }}>
                          {JSON.stringify(ch.previousValue) ?? 'undefined'}
                        </td>
                        <td style={{ padding: '0.5rem 0.75rem', color: '#34d399', background: 'rgba(16, 185, 129, 0.05)' }}>
                          {JSON.stringify(ch.newValue) ?? 'undefined'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', background: '#0b0f19', borderRadius: 6 }}>
                Both versions are structurally identical.
              </div>
            )}
          </div>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
          <button className="btn btn-primary" onClick={onClose}>Close Diff</button>
        </div>
      </div>
    </div>
  );
};
