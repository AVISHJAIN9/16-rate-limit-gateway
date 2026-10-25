import React, { useState, useEffect, useRef } from 'react';
import { api, onUnauthorized, setToken } from './api.js';
import { Sparkline } from './components/Sparkline.js';
import { QuotaHeatmap } from './components/Heatmap.js';
import { TopologySvg } from './components/TopologySvg.js';
import { LatencyGauge } from './components/LatencyGauge.js';
import { AlgorithmExplainer } from './components/AlgorithmExplainer.js';
import { SandboxView } from './components/SandboxView.js';
import { PolicyEditorModal } from './components/PolicyEditorModal.js';
import { VersionHistoryModal } from './components/VersionHistoryModal.js';
import { SemanticDiffModal } from './components/SemanticDiffModal.js';
import { LookupsView } from './components/LookupsView.js';
import { AnalyticsView } from './components/AnalyticsView.js';
import { SecurityOpsView } from './components/SecurityOpsView.js';
import { LoginModal } from './components/LoginModal.js';

export const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<any | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);

  type TabType = 'overview' | 'policies' | 'lookups' | 'analytics' | 'security' | 'sandbox' | 'explainer' | 'topology';
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [isPaused, setIsPaused] = useState(false);

  // Overview states
  const [throughputHistory, setThroughputHistory] = useState<number[]>([120, 140, 155, 170, 185, 200, 215, 220, 240]);
  const [reqRate, setReqRate] = useState(240);
  const [rejectRatio, setRejectRatio] = useState(0.018);
  const [breakerState, setBreakerState] = useState<'CLOSED' | 'HALF_OPEN' | 'OPEN'>('CLOSED');
  const [snapshotGen, setSnapshotGen] = useState(1);
  const [snapshotHash, setSnapshotHash] = useState('sha256-init');
  const [latencyQuantiles, setLatencyQuantiles] = useState({ p50: 1.2, p90: 3.5, p99: 8.9, p999: 18.2 });

  // Policies states
  const [policies, setPolicies] = useState<any[]>([]);
  const [policiesLoading, setPoliciesLoading] = useState(false);
  const [policySearch, setPolicySearch] = useState('');
  const [selectedPolicyForVersion, setSelectedPolicyForVersion] = useState<string | null>(null);
  const [selectedPolicyForDiff, setSelectedPolicyForDiff] = useState<string | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);

  // Live decision feed (F139)
  const [liveFeed, setLiveFeed] = useState<Array<{
    id: string;
    ts: string;
    tenant: string;
    client: string;
    route: string;
    reason: string;
    retryAfter: number;
    allowed: boolean;
  }>>([]);

  const eventSourceRef = useRef<EventSource | null>(null);

  // Session check
  useEffect(() => {
    onUnauthorized(() => {
      setCurrentUser(null);
      setShowLoginModal(true);
    });

    api.getMe()
      .then((user) => {
        setCurrentUser(user);
      })
      .catch(() => {
        // Prompt login if unauthenticated
        setShowLoginModal(true);
      });
  }, []);

  // Poll overview & metrics
  useEffect(() => {
    if (!currentUser || isPaused) return;

    const fetchOverview = async () => {
      try {
        const data = await api.getOverview();
        if (data) {
          if (typeof data.reqRate === 'number') {
            setReqRate(data.reqRate);
            setThroughputHistory((prev) => [...prev.slice(1), data.reqRate]);
          }
          if (typeof data.rejectionRatio === 'number') {
            setRejectRatio(data.rejectionRatio);
          }
          if (data.breakerState) setBreakerState(data.breakerState);
          if (data.snapshotGen) setSnapshotGen(data.snapshotGen);
          if (data.snapshotHash) setSnapshotHash(data.snapshotHash);
          if (data.latencyQuantiles) setLatencyQuantiles(data.latencyQuantiles);
        }
      } catch {
        // Fallback or retry
      }
    };

    fetchOverview();
    const interval = setInterval(fetchOverview, 3000);
    return () => clearInterval(interval);
  }, [currentUser, isPaused]);

  // Load Policies
  const loadPolicies = async () => {
    try {
      setPoliciesLoading(true);
      const res = await api.getPolicies({ search: policySearch });
      if (res && res.policies) {
        setPolicies(res.policies);
      }
    } catch (err) {
      console.error('Failed to load policies', err);
    } finally {
      setPoliciesLoading(false);
    }
  };

  useEffect(() => {
    if (currentUser) {
      loadPolicies();
    }
  }, [currentUser, policySearch]);

  // SSE Live Feed setup (F139 with visibility auto-pause & backpressure)
  useEffect(() => {
    if (!currentUser || isPaused) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    const handleVisibility = () => {
      if (document.hidden && eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      } else if (!document.hidden && !eventSourceRef.current && !isPaused) {
        initSse();
      }
    };

    const initSse = () => {
      try {
        const es = new EventSource('/admin/v1/stream/decisions');
        eventSourceRef.current = es;

        es.onmessage = (event) => {
          try {
            const dec = JSON.parse(event.data);
            if (dec && !dec.allowed) {
              const item = {
                id: `dec-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
                ts: new Date().toLocaleTimeString(),
                tenant: dec.tenantId || 'global',
                client: dec.identity || 'anonymous',
                route: dec.route || '/*',
                reason: dec.reason || 'limit_exceeded',
                retryAfter: dec.retryAfterSeconds ?? 1,
                allowed: dec.allowed
              };
              setLiveFeed((prev) => [item, ...prev.slice(0, 49)]);
            }
          } catch {
            // Ignore parse errors
          }
        };

        es.onerror = () => {
          if (es.readyState === EventSource.CLOSED) {
            es.close();
            eventSourceRef.current = null;
          }
        };
      } catch {
        // SSE error
      }
    };

    initSse();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [currentUser, isPaused]);

  const handleLogout = () => {
    setToken(null);
    setCurrentUser(null);
    setShowLoginModal(true);
  };

  const handleCreatePolicy = async (newPol: any, reason: string) => {
    try {
      await api.createPolicy(newPol, reason);
      await loadPolicies();
      setIsEditorOpen(false);
    } catch (err: any) {
      alert(`Failed to create policy: ${err.message}`);
    }
  };

  const handleDeletePolicy = async (id: string) => {
    if (!confirm(`Are you sure you want to delete policy '${id}'?`)) return;
    try {
      await api.deletePolicy(id);
      await loadPolicies();
    } catch (err: any) {
      alert(`Failed to delete policy: ${err.message}`);
    }
  };

  return (
    <div>
      {/* Top Header */}
      <header className="header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#6366f1', boxShadow: '0 0 10px #6366f1' }} />
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, letterSpacing: '-0.02em' }}>RLGW Control Plane</h1>
          <span className="badge badge-success" style={{ marginLeft: 8 }}>v1.0.0-PROD</span>
        </div>

        <nav className="nav-tabs" role="tablist">
          <button className={`nav-tab ${activeTab === 'overview' ? 'active' : ''}`} onClick={() => setActiveTab('overview')}>
            Overview
          </button>
          <button className={`nav-tab ${activeTab === 'policies' ? 'active' : ''}`} onClick={() => setActiveTab('policies')}>
            Policies (X8)
          </button>
          <button className={`nav-tab ${activeTab === 'lookups' ? 'active' : ''}`} onClick={() => setActiveTab('lookups')}>
            Lookups (X10)
          </button>
          <button className={`nav-tab ${activeTab === 'analytics' ? 'active' : ''}`} onClick={() => setActiveTab('analytics')}>
            Analytics (X11)
          </button>
          <button className={`nav-tab ${activeTab === 'security' ? 'active' : ''}`} onClick={() => setActiveTab('security')}>
            Security & Ops
          </button>
          <button className={`nav-tab ${activeTab === 'sandbox' ? 'active' : ''}`} onClick={() => setActiveTab('sandbox')}>
            Sandbox (F140)
          </button>
          <button className={`nav-tab ${activeTab === 'explainer' ? 'active' : ''}`} onClick={() => setActiveTab('explainer')}>
            Algorithms (X12)
          </button>
          <button className={`nav-tab ${activeTab === 'topology' ? 'active' : ''}`} onClick={() => setActiveTab('topology')}>
            Topology (F142)
          </button>
        </nav>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          {currentUser ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span className="badge badge-warning" style={{ fontSize: '0.75rem' }}>
                {currentUser.username} ({currentUser.role})
              </span>
              <button className="btn btn-secondary" style={{ padding: '0.35rem 0.65rem', fontSize: '0.8rem' }} onClick={handleLogout}>
                Logout
              </button>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={() => setShowLoginModal(true)}>
              Login
            </button>
          )}

          <button className="btn btn-secondary" onClick={() => setIsPaused(!isPaused)}>
            {isPaused ? '▶ Resume' : '⏸ Pause'}
          </button>

          <button className="btn btn-primary" onClick={() => setIsEditorOpen(true)}>
            + New Policy
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="container">
        {activeTab === 'overview' && (
          <>
            {/* Stat Cards */}
            <div className="grid-stats">
              <div className="glass-card">
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Throughput</div>
                <div style={{ fontSize: '1.75rem', fontWeight: 700, margin: '0.25rem 0' }}>
                  {reqRate} <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>req/s</span>
                </div>
                <Sparkline data={throughputHistory} />
              </div>

              <div className="glass-card">
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>429 Rejection Ratio</div>
                <div style={{ fontSize: '1.75rem', fontWeight: 700, margin: '0.25rem 0', color: rejectRatio > 0.05 ? '#ef4444' : '#10b981' }}>
                  {(rejectRatio * 100).toFixed(1)}%
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Target: &lt; 5.0% normal load</div>
              </div>

              <div className="glass-card">
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Circuit Breaker</div>
                <div style={{ fontSize: '1.75rem', fontWeight: 700, margin: '0.25rem 0', color: breakerState === 'CLOSED' ? '#10b981' : '#ef4444' }}>
                  {breakerState}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>All upstreams healthy</div>
              </div>

              <div className="glass-card">
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Active Snapshot</div>
                <div style={{ fontSize: '1.75rem', fontWeight: 700, margin: '0.25rem 0' }}>
                  Gen {snapshotGen}
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                  Hash: {snapshotHash.substring(0, 12)}...
                </div>
              </div>
            </div>

            {/* Latency Gauges (F143) */}
            <div style={{ marginBottom: '2rem' }}>
              <LatencyGauge quantiles={latencyQuantiles} />
            </div>

            {/* Heatmap & Live Feed */}
            <div className="grid-2col">
              <QuotaHeatmap
                data={[
                  { policyId: 'pol_global_burst', buckets: [0.1, 0.2, 0.4, 0.5, 0.45, 0.6] },
                  { policyId: 'pol_checkout_strict', buckets: [0.3, 0.6, 0.85, 0.95, 0.7, 0.4] },
                  { policyId: 'pol_search_gcra', buckets: [0.05, 0.1, 0.15, 0.2, 0.18, 0.25] }
                ]}
                timeLabels={['12:00', '12:01', '12:02', '12:03', '12:04', '12:05']}
              />

              <div className="glass-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>F139: Throttled Request Live Feed (SSE)</h3>
                  {liveFeed.length > 0 && (
                    <button className="btn btn-secondary" style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }} onClick={() => setLiveFeed([])}>
                      Clear
                    </button>
                  )}
                </div>

                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Client</th>
                        <th>Route</th>
                        <th>Reason</th>
                        <th>Retry</th>
                      </tr>
                    </thead>
                    <tbody>
                      {liveFeed.length === 0 ? (
                        <tr>
                          <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '1.5rem 0' }}>
                            Waiting for throttled traffic stream...
                          </td>
                        </tr>
                      ) : (
                        liveFeed.map((item) => (
                          <tr key={item.id}>
                            <td>{item.ts}</td>
                            <td style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{item.client}</td>
                            <td style={{ fontSize: '0.8rem' }}>{item.route}</td>
                            <td><span className="badge badge-danger">{item.reason}</span></td>
                            <td>{item.retryAfter}s</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Policies Tab (X8) */}
        {activeTab === 'policies' && (
          <div className="glass-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
              <div>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Active Gateway Policies (X8)</h3>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  Manage rate limit specifications with immutable versioning, rollback, and semantic diff.
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  className="input-field"
                  placeholder="Search policies..."
                  value={policySearch}
                  onChange={(e) => setPolicySearch(e.target.value)}
                  style={{ width: 220 }}
                />
                <button className="btn btn-secondary" onClick={loadPolicies}>⟳ Refresh</button>
              </div>
            </div>

            {policiesLoading ? (
              <div style={{ textAlign: 'center', padding: '2rem 0', color: 'var(--text-muted)' }}>Loading policies...</div>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Policy ID</th>
                      <th>Tenant</th>
                      <th>Algorithm</th>
                      <th>Capacity / Refill</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {policies.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '1.5rem 0' }}>
                          No policies found.
                        </td>
                      </tr>
                    ) : (
                      policies.map((p) => (
                        <tr key={p.id}>
                          <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{p.id}</td>
                          <td><span className="badge badge-secondary">{p.tenant || 'global'}</span></td>
                          <td><span className="badge badge-warning">{p.algorithm}</span></td>
                          <td>{p.params?.capacity ?? p.limit ?? 100} units</td>
                          <td>
                            <div style={{ display: 'flex', gap: '0.35rem' }}>
                              <button
                                className="btn btn-secondary"
                                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                onClick={() => setSelectedPolicyForVersion(p.id)}
                              >
                                History
                              </button>
                              <button
                                className="btn btn-secondary"
                                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                onClick={() => setSelectedPolicyForDiff(p.id)}
                              >
                                Diff
                              </button>
                              <button
                                className="btn btn-danger"
                                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                onClick={() => handleDeletePolicy(p.id)}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Lookups Tab (X10) */}
        {activeTab === 'lookups' && <LookupsView />}

        {/* Analytics Tab (X11) */}
        {activeTab === 'analytics' && <AnalyticsView />}

        {/* Security & Ops Tab */}
        {activeTab === 'security' && <SecurityOpsView />}

        {/* Sandbox Tab (F140) */}
        {activeTab === 'sandbox' && <SandboxView />}

        {/* Algorithm Explainer Tab (X12) */}
        {activeTab === 'explainer' && <AlgorithmExplainer />}

        {/* Topology Tab (F142) */}
        {activeTab === 'topology' && <TopologySvg />}
      </main>

      {/* Modals */}
      <PolicyEditorModal
        isOpen={isEditorOpen}
        onClose={() => setIsEditorOpen(false)}
        onSave={handleCreatePolicy}
      />

      {selectedPolicyForVersion && (
        <VersionHistoryModal
          policyId={selectedPolicyForVersion}
          isOpen={true}
          onClose={() => setSelectedPolicyForVersion(null)}
          onActionComplete={loadPolicies}
        />
      )}

      {selectedPolicyForDiff && (
        <SemanticDiffModal
          policyId={selectedPolicyForDiff}
          isOpen={true}
          onClose={() => setSelectedPolicyForDiff(null)}
        />
      )}

      {showLoginModal && (
        <LoginModal
          onSuccess={(user) => {
            setCurrentUser(user);
            setShowLoginModal(false);
          }}
        />
      )}
    </div>
  );
};
