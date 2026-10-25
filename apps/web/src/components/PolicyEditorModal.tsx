import React, { useState } from 'react';

export interface PolicyEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (policy: any, reason: string) => void;
}

export const PolicyEditorModal: React.FC<PolicyEditorProps> = ({ isOpen, onClose, onSave }) => {
  const [policyId, setPolicyId] = useState('');
  const [tenant, setTenant] = useState('global');
  const [algorithm, setAlgorithm] = useState('token_bucket');
  const [limit, setLimit] = useState(100);
  const [reason, setReason] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!policyId.trim()) {
      setErrorMsg('Policy ID is required');
      return;
    }
    if (!reason.trim()) {
      setErrorMsg('Audit reason is required for policy changes');
      return;
    }

    const policy = {
      id: policyId,
      tenant,
      match: { route: '/*' },
      algorithm,
      params: { type: algorithm, capacity: limit, refillRate: limit },
      failMode: 'fail_closed'
    };

    onSave(policy, reason);
    onClose();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div className="glass-card" style={{ width: 480, background: '#111827' }}>
        <h3 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '1rem' }}>F141: Policy Editor & Linter</h3>
        {errorMsg && <div style={{ color: '#ef4444', fontSize: '0.85rem', marginBottom: '1rem' }}>{errorMsg}</div>}
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Policy ID</label>
            <input
              type="text"
              value={policyId}
              onChange={(e) => setPolicyId(e.target.value)}
              placeholder="e.g. tier1_burst_limit"
              style={{ width: '100%', padding: '8px 12px', background: '#1f2937', color: '#fff', border: '1px solid var(--border-color)', borderRadius: 6 }}
            />
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Tenant</label>
            <input
              type="text"
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', background: '#1f2937', color: '#fff', border: '1px solid var(--border-color)', borderRadius: 6 }}
            />
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Algorithm</label>
            <select
              value={algorithm}
              onChange={(e) => setAlgorithm(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', background: '#1f2937', color: '#fff', border: '1px solid var(--border-color)', borderRadius: 6 }}
            >
              <option value="token_bucket">Token Bucket</option>
              <option value="fixed_window">Fixed Window</option>
              <option value="gcra">GCRA</option>
            </select>
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Quota Limit / Capacity</label>
            <input
              type="number"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              style={{ width: '100%', padding: '8px 12px', background: '#1f2937', color: '#fff', border: '1px solid var(--border-color)', borderRadius: 6 }}
            />
          </div>
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Audit Reason (Required)</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Scaling for marketing campaign"
              style={{ width: '100%', padding: '8px 12px', background: '#1f2937', color: '#fff', border: '1px solid var(--border-color)', borderRadius: 6 }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Save Policy</button>
          </div>
        </form>
      </div>
    </div>
  );
};
