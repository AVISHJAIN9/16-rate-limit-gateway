import React, { useState } from 'react';
import { api } from '../api.js';

interface LoginModalProps {
  onSuccess: (user: any) => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ onSuccess }) => {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [tokenInput, setTokenInput] = useState('');
  const [mode, setMode] = useState<'creds' | 'token'>('creds');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === 'token') {
        const res = await api.login({ token: tokenInput });
        onSuccess(res.user);
      } else {
        const res = await api.login({ username, password });
        onSuccess(res.user);
      }
    } catch (err: any) {
      setError(err?.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const selectDevRole = (user: string, pass: string) => {
    setUsername(user);
    setPassword(pass);
    setMode('creds');
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card" style={{ maxWidth: 440 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem' }}>
          <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#6366f1', boxShadow: '0 0 10px #6366f1' }} />
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>RLGW Admin Authentication</h2>
        </div>

        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
          Security requirement: Session tokens reside strictly in-memory. Select a dev role or enter an admin token.
        </p>

        {/* Quick Role Selector */}
        <div style={{ marginBottom: '1.25rem' }}>
          <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Quick Dev Roles:
          </label>
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
            <button
              type="button"
              className={`btn btn-secondary ${username === 'admin' ? 'active' : ''}`}
              style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
              onClick={() => selectDevRole('admin', 'admin123')}
            >
              super-admin
            </button>
            <button
              type="button"
              className={`btn btn-secondary ${username === 'policy-admin' ? 'active' : ''}`}
              style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
              onClick={() => selectDevRole('policy-admin', 'policyadmin123')}
            >
              policy-admin
            </button>
            <button
              type="button"
              className={`btn btn-secondary ${username === 'operator' ? 'active' : ''}`}
              style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
              onClick={() => selectDevRole('operator', 'operator123')}
            >
              operator
            </button>
            <button
              type="button"
              className={`btn btn-secondary ${username === 'tenant-admin' ? 'active' : ''}`}
              style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
              onClick={() => selectDevRole('tenant-admin', 'tenantadmin123')}
            >
              tenant-admin (acme)
            </button>
            <button
              type="button"
              className={`btn btn-secondary ${username === 'viewer' ? 'active' : ''}`}
              style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
              onClick={() => selectDevRole('viewer', 'viewer123')}
            >
              viewer
            </button>
          </div>
        </div>

        <form onSubmit={handleLogin}>
          {mode === 'creds' ? (
            <>
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                  Username
                </label>
                <input
                  type="text"
                  className="input"
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', background: '#111827', border: '1px solid #374151', color: '#fff' }}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>

              <div style={{ marginBottom: '1.25rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                  Password
                </label>
                <input
                  type="password"
                  className="input"
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', background: '#111827', border: '1px solid #374151', color: '#fff' }}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
            </>
          ) : (
            <div style={{ marginBottom: '1.25rem' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                Admin Token
              </label>
              <input
                type="text"
                className="input"
                style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', background: '#111827', border: '1px solid #374151', color: '#fff' }}
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Bearer secret token..."
                required
              />
            </div>
          )}

          {error && (
            <div style={{ padding: '0.5rem 0.75rem', marginBottom: '1rem', borderRadius: '6px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid #ef4444', color: '#fca5a5', fontSize: '0.85rem' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1.5rem' }}>
            <button
              type="button"
              className="btn"
              style={{ fontSize: '0.8rem', background: 'transparent', color: '#6366f1', textDecoration: 'underline' }}
              onClick={() => setMode(mode === 'creds' ? 'token' : 'creds')}
            >
              {mode === 'creds' ? 'Use Static Token' : 'Use Username / Password'}
            </button>

            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Authenticating...' : 'Sign In'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
