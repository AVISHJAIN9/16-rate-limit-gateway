import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

export const SecurityOpsView: React.FC = () => {
  const [overrides, setOverrides] = useState<any[]>([]);
  const [allowlist, setAllowlist] = useState<any[]>([]);
  const [denylist, setDenylist] = useState<any[]>([]);
  const [jailed, setJailed] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // New item form states
  const [overrideKey, setOverrideKey] = useState('');
  const [overrideMult, setOverrideMult] = useState(2.0);
  const [overrideTtl, setOverrideTtl] = useState(300);
  const [overrideReason, setOverrideReason] = useState('Incident mitigation');

  const [allowType, setAllowType] = useState('ip');
  const [allowVal, setAllowVal] = useState('');
  const [allowReason, setAllowReason] = useState('Partner VIP pass');

  const [denyType, setDenyType] = useState('ip');
  const [denyVal, setDenyVal] = useState('');
  const [denyReason, setDenyReason] = useState('Abusive scraper');

  async function refreshData() {
    try {
      setLoading(true);
      const [ovData, alData, dlData, jlData] = await Promise.all([
        api.getOverrides().catch(() => []),
        api.getAllowlist().catch(() => []),
        api.getDenylist().catch(() => []),
        api.getJail().catch(() => [])
      ]);
      setOverrides(Array.isArray(ovData) ? ovData : []);
      setAllowlist(Array.isArray(alData) ? alData : []);
      setDenylist(Array.isArray(dlData) ? dlData : []);
      setJailed(Array.isArray(jlData) ? jlData : []);
    } catch (err) {
      console.error('Failed to load security ops data', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshData();
  }, []);

  async function handleAddOverride(e: React.FormEvent) {
    e.preventDefault();
    if (!overrideKey) return;
    try {
      await api.createOverride({
        key: overrideKey,
        multiplier: overrideMult,
        ttlSeconds: overrideTtl,
        reason: overrideReason
      });
      setOverrideKey('');
      await refreshData();
    } catch (err: any) {
      alert(`Error creating override: ${err.message}`);
    }
  }

  async function handleDeleteOverride(key: string) {
    try {
      await api.deleteOverride(key);
      await refreshData();
    } catch (err: any) {
      alert(`Error deleting override: ${err.message}`);
    }
  }

  async function handleAddAllowlist(e: React.FormEvent) {
    e.preventDefault();
    if (!allowVal) return;
    try {
      await api.addAllowlist({ type: allowType, value: allowVal, reason: allowReason });
      setAllowVal('');
      await refreshData();
    } catch (err: any) {
      alert(`Error adding allowlist item: ${err.message}`);
    }
  }

  async function handleDeleteAllowlist(target: string) {
    try {
      await api.deleteAllowlist(target);
      await refreshData();
    } catch (err: any) {
      alert(`Error removing allowlist item: ${err.message}`);
    }
  }

  async function handleAddDenylist(e: React.FormEvent) {
    e.preventDefault();
    if (!denyVal) return;
    try {
      await api.addDenylist({ type: denyType, value: denyVal, reason: denyReason });
      setDenyVal('');
      await refreshData();
    } catch (err: any) {
      alert(`Error adding denylist item: ${err.message}`);
    }
  }

  async function handleDeleteDenylist(target: string) {
    try {
      await api.deleteDenylist(target);
      await refreshData();
    } catch (err: any) {
      alert(`Error removing denylist item: ${err.message}`);
    }
  }

  async function handleReleaseJail() {
    try {
      await api.releaseJail();
      await refreshData();
    } catch (err: any) {
      alert(`Error releasing jail: ${err.message}`);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header */}
      <div className="glass-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Security & Operations Console</h2>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Dynamic limit overrides, immediate IP/Client bypass filters, and jailhouse enforcement.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {loading && <span className="badge badge-warning">Loading...</span>}
          <button className="btn btn-secondary" onClick={refreshData}>⟳ Refresh</button>
        </div>
      </div>

      {/* Jailhouse Panel */}
      <div className="glass-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <div>
            <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Tarpit & Jailhouse (Active Blocks)</h3>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Identities automatically or administratively placed in containment.
            </span>
          </div>
          {jailed.length > 0 && (
            <button className="btn btn-danger" onClick={handleReleaseJail}>
              Release All Jailed
            </button>
          )}
        </div>

        {jailed.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No clients currently jailed.</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {jailed.map((j) => (
              <span key={j} className="badge badge-danger" style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                {j}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Dynamic Overrides */}
      <div className="glass-card">
        <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
          Dynamic Quota Overrides (Temporary Multipliers)
        </h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
          Apply temporary quota boosts (e.g. 2x, 5x) during sales events or VIP migrations with auto-expiring TTL.
        </p>

        {/* Add form */}
        <form onSubmit={handleAddOverride} style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          <input
            type="text"
            className="input-field"
            placeholder="Target Key / Identity (e.g. client:corp_vip)"
            value={overrideKey}
            onChange={(e) => setOverrideKey(e.target.value)}
            style={{ flex: 2, minWidth: 200 }}
            required
          />
          <input
            type="number"
            step="0.1"
            className="input-field"
            placeholder="Multiplier (e.g. 2.0)"
            value={overrideMult}
            onChange={(e) => setOverrideMult(Number(e.target.value))}
            style={{ width: 120 }}
            required
          />
          <input
            type="number"
            className="input-field"
            placeholder="TTL Sec"
            value={overrideTtl}
            onChange={(e) => setOverrideTtl(Number(e.target.value))}
            style={{ width: 100 }}
            required
          />
          <input
            type="text"
            className="input-field"
            placeholder="Reason"
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            style={{ flex: 1, minWidth: 150 }}
          />
          <button type="submit" className="btn btn-primary">+ Apply Override</button>
        </form>

        {/* Overrides Table */}
        {overrides.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No active overrides.</div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Target Key</th>
                  <th>Multiplier</th>
                  <th>TTL Remaining</th>
                  <th>Reason</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {overrides.map((ov) => (
                  <tr key={ov.key}>
                    <td style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--text-primary)' }}>{ov.key}</td>
                    <td><span className="badge badge-success">{ov.multiplier}x</span></td>
                    <td>{ov.ttlSeconds}s</td>
                    <td style={{ color: 'var(--text-secondary)' }}>{ov.reason}</td>
                    <td>
                      <button className="btn btn-danger" style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }} onClick={() => handleDeleteOverride(ov.key)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Allowlist & Denylist Grid */}
      <div className="grid-2col">
        {/* Allowlist */}
        <div className="glass-card">
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            Allowlist (Unrestricted Access)
          </h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            Always bypasses rate limiting checks (useful for webhooks and health monitors).
          </p>

          <form onSubmit={handleAddAllowlist} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <select className="input-field" value={allowType} onChange={(e) => setAllowType(e.target.value)} style={{ width: 80 }}>
              <option value="ip">IP</option>
              <option value="client">Client</option>
            </select>
            <input
              type="text"
              className="input-field"
              placeholder="Value (e.g. 10.0.0.1)"
              value={allowVal}
              onChange={(e) => setAllowVal(e.target.value)}
              style={{ flex: 1 }}
              required
            />
            <button type="submit" className="btn btn-secondary">+ Add</button>
          </form>

          {allowlist.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Allowlist is empty.</div>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Value</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {allowlist.map((item) => (
                    <tr key={item.value}>
                      <td><span className="badge badge-success">{item.type}</span></td>
                      <td style={{ fontFamily: 'monospace' }}>{item.value}</td>
                      <td>
                        <button className="btn btn-danger" style={{ padding: '0.2rem 0.4rem', fontSize: '0.7rem' }} onClick={() => handleDeleteAllowlist(item.value)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Denylist */}
        <div className="glass-card">
          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            Denylist (Immediate 403 Dropped)
          </h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            Drop traffic unconditionally before entering limiters or upstreams.
          </p>

          <form onSubmit={handleAddDenylist} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <select className="input-field" value={denyType} onChange={(e) => setDenyType(e.target.value)} style={{ width: 80 }}>
              <option value="ip">IP</option>
              <option value="client">Client</option>
            </select>
            <input
              type="text"
              className="input-field"
              placeholder="Value (e.g. 198.51.100.4)"
              value={denyVal}
              onChange={(e) => setDenyVal(e.target.value)}
              style={{ flex: 1 }}
              required
            />
            <button type="submit" className="btn btn-secondary">+ Add</button>
          </form>

          {denylist.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Denylist is empty.</div>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Value</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {denylist.map((item) => (
                    <tr key={item.value}>
                      <td><span className="badge badge-danger">{item.type}</span></td>
                      <td style={{ fontFamily: 'monospace' }}>{item.value}</td>
                      <td>
                        <button className="btn btn-danger" style={{ padding: '0.2rem 0.4rem', fontSize: '0.7rem' }} onClick={() => handleDeleteDenylist(item.value)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
