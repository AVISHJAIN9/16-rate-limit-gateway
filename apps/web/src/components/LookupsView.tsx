import React, { useState, useEffect } from 'react';
import { api } from '../api.js';

export const LookupsView: React.FC = () => {
  const [lookupType, setLookupType] = useState<'client' | 'tenant' | 'route'>('client');
  const [lookupId, setLookupId] = useState('client-101');
  const [tenantScope, setTenantScope] = useState('global');
  const [result, setResult] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live SSE Counter state
  const [streamKey, setStreamKey] = useState('rl:{global:client-101}:pol_global_burst:token_bucket');
  const [liveCounter, setLiveCounter] = useState<any | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  const handleLookup = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!lookupId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      if (lookupType === 'client') {
        const data = await api.getClientLookup(lookupId, tenantScope);
        setResult(data);
      } else if (lookupType === 'tenant') {
        const data = await api.getTenantLookup(lookupId);
        setResult(data);
      } else {
        const data = await api.getRouteLookup(lookupId);
        setResult(data);
      }
    } catch (err: any) {
      setError(err?.message || 'Lookup failed');
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isStreaming || !streamKey) return;
    const es = new EventSource(`/admin/v1/stream/counters?key=${encodeURIComponent(streamKey)}`);
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        setLiveCounter(parsed);
      } catch {
        // Ping
      }
    };
    es.onerror = () => {
      // Reconnect
    };
    return () => {
      es.close();
    };
  }, [isStreaming, streamKey]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
      {/* Lookup Card */}
      <div className="glass-card">
        <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.75rem' }}>
          X10: Entity Inspection & Effective Policies
        </h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
          Query effective policy matching, current quota peek, and recent decisions across boundaries.
        </p>

        <form onSubmit={handleLookup} style={{ marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <button
              type="button"
              className={`btn btn-secondary ${lookupType === 'client' ? 'active' : ''}`}
              onClick={() => { setLookupType('client'); setLookupId('client-101'); }}
            >
              Client
            </button>
            <button
              type="button"
              className={`btn btn-secondary ${lookupType === 'tenant' ? 'active' : ''}`}
              onClick={() => { setLookupType('tenant'); setLookupId('acme'); }}
            >
              Tenant
            </button>
            <button
              type="button"
              className={`btn btn-secondary ${lookupType === 'route' ? 'active' : ''}`}
              onClick={() => { setLookupType('route'); setLookupId('/api/v1/orders'); }}
            >
              Route
            </button>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="text"
              className="input"
              style={{ flex: 1, padding: '0.5rem', borderRadius: 6, background: '#111827', border: '1px solid #374151', color: '#fff' }}
              value={lookupId}
              onChange={(e) => setLookupId(e.target.value)}
              placeholder={`Enter ${lookupType} ID...`}
              required
            />
            {lookupType === 'client' && (
              <input
                type="text"
                className="input"
                style={{ width: 100, padding: '0.5rem', borderRadius: 6, background: '#111827', border: '1px solid #374151', color: '#fff' }}
                value={tenantScope}
                onChange={(e) => setTenantScope(e.target.value)}
                placeholder="Tenant"
              />
            )}
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Searching...' : 'Inspect'}
            </button>
          </div>
        </form>

        {error && (
          <div style={{ padding: '0.5rem 0.75rem', borderRadius: 6, background: 'rgba(239,68,68,0.15)', border: '1px solid #ef4444', color: '#fca5a5', fontSize: '0.85rem', marginBottom: '1rem' }}>
            {error}
          </div>
        )}

        {result && (
          <div style={{ background: '#0b0f19', borderRadius: 6, padding: '1rem', border: '1px solid #1f2937', fontSize: '0.8rem' }}>
            <div style={{ fontWeight: 600, color: '#6366f1', marginBottom: '0.5rem' }}>Inspection Output:</div>
            <pre style={{ margin: 0, overflowX: 'auto', color: '#e5e7eb' }}>
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        )}
      </div>

      {/* Live Counter SSE Stream Card */}
      <div className="glass-card">
        <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.75rem' }}>
          Live Counter Stream (SSE)
        </h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
          Subscribe to real-time atomic counter updates directly from the storage layer via Server-Sent Events.
        </p>

        <div style={{ marginBottom: '1.25rem' }}>
          <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Storage Key:</label>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: 4 }}>
            <input
              type="text"
              className="input"
              style={{ flex: 1, padding: '0.5rem', borderRadius: 6, background: '#111827', border: '1px solid #374151', color: '#fff', fontSize: '0.8rem' }}
              value={streamKey}
              onChange={(e) => setStreamKey(e.target.value)}
            />
            <button
              className={`btn ${isStreaming ? 'btn-secondary' : 'btn-primary'}`}
              onClick={() => setIsStreaming(!isStreaming)}
            >
              {isStreaming ? 'Stop SSE' : 'Stream SSE'}
            </button>
          </div>
        </div>

        <div style={{ background: '#0b0f19', borderRadius: 6, padding: '1.25rem', border: '1px solid #1f2937', minHeight: 180 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>SSE Stream Status:</span>
            <span className={`badge ${isStreaming ? 'badge-success' : 'badge-warning'}`}>
              {isStreaming ? 'CONNECTED (1s poll)' : 'IDLE'}
            </span>
          </div>

          {liveCounter ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem', textAlign: 'center' }}>
              <div style={{ background: '#111827', padding: '0.75rem', borderRadius: 6 }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Allowed</div>
                <div style={{ fontSize: '1.25rem', fontWeight: 700, color: liveCounter.allowed ? '#10b981' : '#ef4444' }}>
                  {liveCounter.allowed ? 'YES' : 'NO'}
                </div>
              </div>
              <div style={{ background: '#111827', padding: '0.75rem', borderRadius: 6 }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Remaining</div>
                <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#6366f1' }}>
                  {liveCounter.remaining ?? 0}
                </div>
              </div>
              <div style={{ background: '#111827', padding: '0.75rem', borderRadius: 6 }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Limit</div>
                <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#e5e7eb' }}>
                  {liveCounter.limit ?? 0}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              {isStreaming ? 'Listening for counter events...' : 'Click "Stream SSE" to begin receiving live counter packets.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
