import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

interface VersionHistoryModalProps {
  policyId: string;
  isOpen: boolean;
  onClose: () => void;
  onActionComplete: () => void;
}

export const VersionHistoryModal: React.FC<VersionHistoryModalProps> = ({
  policyId,
  isOpen,
  onClose,
  onActionComplete
}) => {
  const [versions, setVersions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const loadVersions = () => {
    if (!policyId) return;
    setLoading(true);
    api.getPolicyVersions(policyId).then((vList) => {
      setVersions(vList || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => {
    if (isOpen) {
      loadVersions();
    }
  }, [isOpen, policyId]);

  const handleActivate = async (version: number) => {
    try {
      await api.activateVersion(policyId, version);
      setActionMsg(`Version ${version} activated successfully!`);
      loadVersions();
      onActionComplete();
    } catch (err: any) {
      setActionMsg(`Error: ${err?.message}`);
    }
  };

  const handleRollback = async (version: number) => {
    if (!confirm(`Are you sure you want to rollback ${policyId} to v${version}?`)) return;
    try {
      const res = await api.rollbackVersion(policyId, version);
      setActionMsg(`Rolled back to v${version}. Changes: ${res.diff?.changes?.length ?? 0} fields.`);
      loadVersions();
      onActionComplete();
    } catch (err: any) {
      setActionMsg(`Error: ${err?.message}`);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop">
      <div className="modal-card" style={{ maxWidth: 680 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.2rem', fontWeight: 700 }}>Policy Version History & Rollback</h2>
          <button className="btn btn-secondary" onClick={onClose} style={{ padding: '0.25rem 0.5rem' }}>✕</button>
        </div>

        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          Policy: <code>{policyId}</code> — Immutable version history with audit trail and atomic rollback.
        </p>

        {actionMsg && (
          <div style={{ padding: '0.5rem 0.75rem', marginBottom: '1rem', borderRadius: 6, background: 'rgba(99, 102, 241, 0.15)', border: '1px solid #6366f1', color: '#c7d2fe', fontSize: '0.85rem' }}>
            {actionMsg}
          </div>
        )}

        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>Loading versions...</div>
        ) : (
          <div style={{ maxHeight: 320, overflowY: 'auto', background: '#0b0f19', borderRadius: 6, border: '1px solid #1f2937' }}>
            <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#111827', textAlign: 'left', borderBottom: '1px solid #1f2937' }}>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Ver</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Author</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Reason</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Hash</th>
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.version} style={{ borderBottom: '1px solid #1f2937' }}>
                    <td style={{ padding: '0.5rem 0.75rem', fontWeight: 700, color: '#6366f1' }}>v{v.version}</td>
                    <td style={{ padding: '0.5rem 0.75rem' }}>{v.author || 'system'}</td>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--text-secondary)' }}>{v.reason || 'N/A'}</td>
                    <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {(v.hash || '').slice(0, 10)}...
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'flex-end' }}>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.4rem', fontSize: '0.75rem' }}
                          onClick={() => handleActivate(v.version)}
                        >
                          Activate
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.4rem', fontSize: '0.75rem', borderColor: '#f59e0b', color: '#fbbf24' }}
                          onClick={() => handleRollback(v.version)}
                        >
                          Rollback
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
};
