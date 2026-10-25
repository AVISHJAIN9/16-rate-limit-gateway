package gateway

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/obs"
	"rlgw/internal/policy"
	"rlgw/internal/store"
)

// AdminAuthenticator defines the authentication hook for accessing the admin API.
type AdminAuthenticator interface {
	Authenticate(r *http.Request) (bool, error)
}

// StaticTokenAuthenticator checks Bearer token or X-Admin-Token against a static secret.
type StaticTokenAuthenticator struct {
	token string
}

// NewStaticTokenAuthenticator creates a StaticTokenAuthenticator.
func NewStaticTokenAuthenticator(token string) *StaticTokenAuthenticator {
	return &StaticTokenAuthenticator{token: strings.TrimSpace(token)}
}

// Authenticate verifies the token in constant time.
func (a *StaticTokenAuthenticator) Authenticate(r *http.Request) (bool, error) {
	if a.token == "" {
		// Empty token implies unauthenticated admin access is forbidden
		return false, nil
	}

	provided := ""
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		provided = strings.TrimPrefix(auth, "Bearer ")
	} else if adminHdr := r.Header.Get("X-Admin-Token"); adminHdr != "" {
		provided = adminHdr
	}

	if provided == "" {
		return false, nil
	}

	matched := subtle.ConstantTimeCompare([]byte(provided), []byte(a.token)) == 1
	return matched, nil
}

// AdminHandlerConfig bundles components for administering the gateway.
type AdminHandlerConfig struct {
	Service     *policy.PolicyService
	Reloader    *policy.DynamicReloader
	Store       store.Store
	BreakerReg  *BreakerRegistry
	MetricsReg  *obs.PrometheusRegistry
	Auth        AdminAuthenticator
	Clock       clock.Clock
	Draining    *atomic.Bool
	ProxyMgr    *ProxyManager
	StartedAt   time.Time
}

// AdminHandler serves /healthz, /readyz, /metrics, and /admin/v1 endpoints.
type AdminHandler struct {
	cfg AdminHandlerConfig
	mux *http.ServeMux
}

// NewAdminHandler constructs the admin HTTP router.
func NewAdminHandler(cfg AdminHandlerConfig) *AdminHandler {
	if cfg.Clock == nil {
		cfg.Clock = clock.NewRealClock()
	}
	if cfg.StartedAt.IsZero() {
		cfg.StartedAt = cfg.Clock.Now()
	}
	if cfg.Draining == nil {
		cfg.Draining = &atomic.Bool{}
	}

	h := &AdminHandler{
		cfg: cfg,
		mux: http.NewServeMux(),
	}

	h.registerRoutes()
	return h
}

func (h *AdminHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mux.ServeHTTP(w, r)
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
}

func (h *AdminHandler) registerRoutes() {
	// F72: Health endpoint
	h.mux.HandleFunc("/healthz", h.handleHealthz)

	// F73: Readiness endpoint
	h.mux.HandleFunc("/readyz", h.handleReadyz)

	// F74: Metrics endpoint
	h.mux.HandleFunc("/metrics", h.handleMetrics)

	// F75: Admin API /admin/v1 routes
	h.mux.HandleFunc("/admin/v1/snapshot", h.requireAuth(h.handleSnapshot))
	h.mux.HandleFunc("/admin/v1/reload", h.requireAuth(h.handleReload))
	h.mux.HandleFunc("/admin/v1/policies", h.requireAuth(h.handlePolicies))
	h.mux.HandleFunc("/admin/v1/policies/", h.requireAuth(h.handlePolicyItem))
	h.mux.HandleFunc("/admin/v1/counters", h.requireAuth(h.handleCounters))
	h.mux.HandleFunc("/admin/v1/breakers", h.requireAuth(h.handleBreakers))
}

func (h *AdminHandler) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.cfg.Auth != nil {
			ok, err := h.cfg.Auth.Authenticate(r)
			if err != nil || !ok {
				writeError(w, http.StatusUnauthorized, "ERR_UNAUTHORIZED", "Invalid or missing admin authentication token")
				return
			}
		}
		next(w, r)
	}
}

// F72: Health endpoint
func (h *AdminHandler) handleHealthz(w http.ResponseWriter, r *http.Request) {
	uptime := h.cfg.Clock.Now().Sub(h.cfg.StartedAt).Seconds()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":         "ok",
		"uptime_seconds": uptime,
	})
}

// F73: Readiness endpoint (503 while draining)
func (h *AdminHandler) handleReadyz(w http.ResponseWriter, r *http.Request) {
	if h.cfg.Draining.Load() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "draining",
			"ready":  false,
		})
		return
	}

	// Verify policy snapshot is loaded
	if h.cfg.Reloader != nil && h.cfg.Reloader.Snapshot() == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "unhealthy",
			"ready":  false,
			"reason": "policy snapshot not loaded",
		})
		return
	}

	// Verify store is reachable
	if h.cfg.Store != nil {
		_, err := h.cfg.Store.Peek(r.Context(), []byte("healthcheck"), store.AlgoSpec{
			Algorithm: "token_bucket",
			Limit:     10,
			Window:    time.Minute,
		}, h.cfg.Clock.Now())
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"status": "unhealthy",
				"ready":  false,
				"reason": fmt.Sprintf("store check failed: %v", err),
			})
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ready",
		"ready":  true,
	})
}

// F74: Metrics endpoint
func (h *AdminHandler) handleMetrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	if h.cfg.MetricsReg != nil {
		_ = h.cfg.MetricsReg.WritePrometheus(w)
		return
	}
	_, _ = io.WriteString(w, "# No metrics recorded yet\n")
}

// F75: GET /admin/v1/snapshot
func (h *AdminHandler) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "ERR_METHOD_NOT_ALLOWED", "Method not allowed")
		return
	}

	var snap *policy.PolicySnapshot
	if h.cfg.Reloader != nil {
		snap = h.cfg.Reloader.Snapshot()
	}

	if snap == nil {
		writeError(w, http.StatusNotFound, "ERR_NOT_FOUND", "No active snapshot")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"env":               snap.Env,
		"version":           snap.Version,
		"compiled_at":       snap.CompiledAt,
		"policies_count":    len(snap.EffectivePolicies),
		"tenant_tree_count": len(snap.TenantTrees),
	})
}

// F75: POST /admin/v1/reload
func (h *AdminHandler) handleReload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "ERR_METHOD_NOT_ALLOWED", "Method not allowed")
		return
	}

	if h.cfg.Reloader == nil {
		writeError(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Dynamic reloader not configured")
		return
	}

	if err := h.cfg.Reloader.Reload(); err != nil {
		writeError(w, http.StatusInternalServerError, "ERR_RELOAD_FAILED", fmt.Sprintf("Reload failed: %v", err))
		return
	}

	snap := h.cfg.Reloader.Snapshot()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":      "reloaded",
		"version":     snap.Version,
		"compiled_at": snap.CompiledAt,
	})
}

// F75: GET/POST /admin/v1/policies
func (h *AdminHandler) handlePolicies(w http.ResponseWriter, r *http.Request) {
	if h.cfg.Service == nil {
		writeError(w, http.StatusBadRequest, "ERR_SERVICE_UNAVAILABLE", "Policy service not configured")
		return
	}

	switch r.Method {
	case http.MethodGet:
		tenant := r.URL.Query().Get("tenant")
		limit := 50
		if lStr := r.URL.Query().Get("limit"); lStr != "" {
			if l, err := strconv.Atoi(lStr); err == nil && l > 0 && l <= 500 {
				limit = l
			}
		}
		page := 1
		if pStr := r.URL.Query().Get("page"); pStr != "" {
			if p, err := strconv.Atoi(pStr); err == nil && p > 0 {
				page = p
			}
		}

		sub := policy.AuthSubject{ID: "admin", Tenant: tenant, Roles: []string{"admin"}, IsSuperAdmin: true}
		filter := policy.ListFilter{Tenant: tenant}
		pag := policy.Pagination{Limit: limit, Page: page}

		res, err := h.cfg.Service.ListPolicies(r.Context(), sub, filter, pag)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "ERR_INTERNAL", err.Error())
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"policies": res.Policies,
			"total":    res.Total,
			"page":     res.Page,
			"count":    len(res.Policies),
		})

	case http.MethodPost:
		var p policy.Policy
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeError(w, http.StatusBadRequest, "ERR_BAD_REQUEST", fmt.Sprintf("Invalid JSON body: %v", err))
			return
		}

		sub := policy.AuthSubject{ID: "admin", Tenant: p.Tenant, Roles: []string{"admin"}, IsSuperAdmin: true}
		created, err := h.cfg.Service.CreatePolicy(r.Context(), sub, p, "admin", "admin API created")
		if err != nil {
			writeError(w, http.StatusBadRequest, "ERR_POLICY_INVALID", err.Error())
			return
		}

		hash, _ := created.Policy.ContentHash()
		w.Header().Set("ETag", hash)
		writeJSON(w, http.StatusCreated, created)

	default:
		writeError(w, http.StatusMethodNotAllowed, "ERR_METHOD_NOT_ALLOWED", "Method not allowed")
	}
}

// F75: GET/PUT/DELETE /admin/v1/policies/{id} and /admin/v1/policies/{id}/rollback
func (h *AdminHandler) handlePolicyItem(w http.ResponseWriter, r *http.Request) {
	if h.cfg.Service == nil {
		writeError(w, http.StatusBadRequest, "ERR_SERVICE_UNAVAILABLE", "Policy service not configured")
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/admin/v1/policies/")
	parts := strings.Split(path, "/")
	id := parts[0]
	if id == "" {
		writeError(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Policy ID required")
		return
	}
	tenant := r.URL.Query().Get("tenant")
	if tenant == "" {
		tenant = "global"
		if listRes, err := h.cfg.Service.ListPolicies(r.Context(), policy.AuthSubject{ID: "admin", Roles: []string{"admin"}, IsSuperAdmin: true}, policy.ListFilter{}, policy.Pagination{Limit: 1000}); err == nil {
			for _, item := range listRes.Policies {
				if item.Policy.ID == id {
					tenant = item.Policy.Tenant
					break
				}
			}
		}
	}
	sub := policy.AuthSubject{ID: "admin", Tenant: tenant, Roles: []string{"admin"}, IsSuperAdmin: true}

	// Check rollback subresource: POST /admin/v1/policies/{id}/rollback
	if len(parts) == 2 && parts[1] == "rollback" {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "ERR_METHOD_NOT_ALLOWED", "Method not allowed")
			return
		}

		var payload struct {
			TargetVersion int64  `json:"target_version"`
			Author        string `json:"author"`
			Reason        string `json:"reason"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeError(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Invalid rollback payload")
			return
		}
		if payload.Author == "" {
			payload.Author = "admin"
		}
		if payload.Reason == "" {
			payload.Reason = "admin API rollback"
		}

		rolled, err := h.cfg.Service.RollbackPolicy(r.Context(), sub, tenant, id, payload.TargetVersion, payload.Author, payload.Reason)
		if err != nil {
			writeError(w, http.StatusBadRequest, "ERR_ROLLBACK_FAILED", err.Error())
			return
		}

		writeJSON(w, http.StatusOK, rolled)
		return
	}

	switch r.Method {
	case http.MethodGet:
		p, err := h.cfg.Service.GetPolicy(r.Context(), sub, tenant, id)
		if err != nil && tenant == "global" {
			listRes, _ := h.cfg.Service.ListPolicies(r.Context(), sub, policy.ListFilter{}, policy.Pagination{Limit: 1000})
			for _, item := range listRes.Policies {
				if item.Policy.ID == id {
					p = item
					err = nil
					break
				}
			}
		}
		if err != nil {
			writeError(w, http.StatusNotFound, "ERR_NOT_FOUND", fmt.Sprintf("Policy %s not found", id))
			return
		}

		hash, _ := p.Policy.ContentHash()
		if match := r.Header.Get("If-None-Match"); match != "" && match == hash {
			w.WriteHeader(http.StatusNotModified)
			return
		}

		w.Header().Set("ETag", hash)
		writeJSON(w, http.StatusOK, p)

	case http.MethodPut:
		var p policy.Policy
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeError(w, http.StatusBadRequest, "ERR_BAD_REQUEST", fmt.Sprintf("Invalid JSON: %v", err))
			return
		}
		p.ID = id
		if p.Tenant != "" {
			tenant = p.Tenant
			sub.Tenant = tenant
		}

		existing, _ := h.cfg.Service.GetPolicy(r.Context(), sub, tenant, id)
		var revInt int64 = existing.Revision
		if ifMatch := r.Header.Get("If-Match"); ifMatch != "" {
			if parsed, err := strconv.ParseInt(ifMatch, 10, 64); err == nil {
				revInt = parsed
			} else {
				curHash, _ := existing.Policy.ContentHash()
				if ifMatch != curHash && ifMatch != "*" {
					writeError(w, http.StatusPreconditionFailed, "ERR_PRECONDITION_FAILED", "If-Match does not match policy hash")
					return
				}
				revInt = existing.Revision
			}
		}

		updated, err := h.cfg.Service.UpdatePolicy(r.Context(), sub, p, revInt, "admin", "admin API update")
		if err != nil {
			writeError(w, http.StatusConflict, "ERR_CONFLICT", err.Error())
			return
		}

		hash, _ := updated.Policy.ContentHash()
		w.Header().Set("ETag", hash)
		writeJSON(w, http.StatusOK, updated)

	case http.MethodDelete:
		var revInt int64
		if ifMatch := r.Header.Get("If-Match"); ifMatch != "" {
			if parsed, err := strconv.ParseInt(ifMatch, 10, 64); err == nil {
				revInt = parsed
			}
		}
		if err := h.cfg.Service.DeletePolicy(r.Context(), sub, tenant, id, revInt); err != nil {
			writeError(w, http.StatusNotFound, "ERR_NOT_FOUND", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "deleted", "id": id})

	default:
		writeError(w, http.StatusMethodNotAllowed, "ERR_METHOD_NOT_ALLOWED", "Method not allowed")
	}
}

// F75: GET /admin/v1/counters?key=...
func (h *AdminHandler) handleCounters(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "ERR_METHOD_NOT_ALLOWED", "Method not allowed")
		return
	}

	key := r.URL.Query().Get("key")
	if key == "" {
		writeError(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Missing required 'key' query parameter")
		return
	}

	limit := int64(100)
	if lStr := r.URL.Query().Get("limit"); lStr != "" {
		if l, err := strconv.ParseInt(lStr, 10, 64); err == nil && l > 0 {
			limit = l
		}
	}

	window := time.Minute
	if wStr := r.URL.Query().Get("window"); wStr != "" {
		if d, err := time.ParseDuration(wStr); err == nil && d > 0 {
			window = d
		}
	}

	spec := store.AlgoSpec{
		Algorithm: "token_bucket",
		Limit:     limit,
		Window:    window,
		Burst:     limit,
	}

	dec, err := h.cfg.Store.Peek(r.Context(), []byte(key), spec, h.cfg.Clock.Now())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "ERR_STORE", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"key":          key,
		"allowed":      dec.Allowed,
		"remaining":    dec.Remaining,
		"current_usage": dec.CurrentUsage,
		"limit":        dec.Limit,
		"reset_after":  dec.ResetAfter.String(),
	})
}

// F75: GET /admin/v1/breakers
func (h *AdminHandler) handleBreakers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "ERR_METHOD_NOT_ALLOWED", "Method not allowed")
		return
	}

	if h.cfg.BreakerReg == nil {
		writeJSON(w, http.StatusOK, map[string]any{"breakers": []any{}})
		return
	}

	stats := h.cfg.BreakerReg.ListStats()
	writeJSON(w, http.StatusOK, map[string]any{
		"breakers": stats,
		"count":    len(stats),
	})
}
