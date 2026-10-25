package gateway

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/obs"
	"rlgw/internal/policy"
	"rlgw/internal/store/memory"
)

func setupTestAdmin(t *testing.T) (*AdminHandler, *atomic.Bool, clock.Clock) {
	fakeClk := clock.NewFakeClock(time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC))
	memStore := memory.NewMemoryStore(1000)
	policyStore := policy.NewMemPolicyStore()
	policyService := policy.NewPolicyService(policyStore, policy.AllowAllAuthorizer{}, fakeClk, policy.ServiceConfig{})
	draining := &atomic.Bool{}
	metricsReg := obs.NewPrometheusRegistry()
	breakerReg := NewBreakerRegistry(fakeClk, metricsReg)

	auth := NewStaticTokenAuthenticator("test-admin-secret")

	adminHandler := NewAdminHandler(AdminHandlerConfig{
		Service:    policyService,
		Store:      memStore,
		BreakerReg: breakerReg,
		MetricsReg: metricsReg,
		Auth:       auth,
		Clock:      fakeClk,
		Draining:   draining,
	})

	return adminHandler, draining, fakeClk
}

func TestHealthAndReadinessEndpoints(t *testing.T) {
	admin, draining, _ := setupTestAdmin(t)

	// 1. Healthz: always 200
	reqHealth := httptest.NewRequest("GET", "/healthz", nil)
	recHealth := httptest.NewRecorder()
	admin.ServeHTTP(recHealth, reqHealth)
	if recHealth.Code != http.StatusOK {
		t.Fatalf("expected 200 from healthz, got %d", recHealth.Code)
	}

	// 2. Readyz when ready: 200
	reqReady := httptest.NewRequest("GET", "/readyz", nil)
	recReady := httptest.NewRecorder()
	admin.ServeHTTP(recReady, reqReady)
	if recReady.Code != http.StatusOK {
		t.Fatalf("expected 200 from readyz, got %d", recReady.Code)
	}

	// 3. Readyz when draining: 503
	draining.Store(true)
	recDraining := httptest.NewRecorder()
	admin.ServeHTTP(recDraining, reqReady)
	if recDraining.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 from readyz while draining, got %d", recDraining.Code)
	}
}

func TestMetricsEndpoint(t *testing.T) {
	admin, _, _ := setupTestAdmin(t)

	req := httptest.NewRequest("GET", "/metrics", nil)
	rec := httptest.NewRecorder()
	admin.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 from metrics, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "gateway_requests_total") {
		t.Errorf("expected gateway_requests_total in metrics output, got: %s", rec.Body.String())
	}
}

func TestAdminAPIAuthAndPolicyCRUD(t *testing.T) {
	admin, _, _ := setupTestAdmin(t)

	// 1. Unauthorized access rejected with 401
	reqUnauth := httptest.NewRequest("GET", "/admin/v1/policies", nil)
	recUnauth := httptest.NewRecorder()
	admin.ServeHTTP(recUnauth, reqUnauth)
	if recUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 Unauthorized, got %d", recUnauth.Code)
	}

	// Helper for authenticated requests
	makeAuthReq := func(method, path string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
		var req *http.Request
		if body != nil {
			req = httptest.NewRequest(method, path, bytes.NewReader(body))
		} else {
			req = httptest.NewRequest(method, path, nil)
		}
		req.Header.Set("Authorization", "Bearer test-admin-secret")
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		admin.ServeHTTP(rec, req)
		return rec
	}

	// 2. Create Policy (POST /admin/v1/policies)
	polPayload := `{
		"id": "pol-billing",
		"name": "Billing Tier Limit",
		"version": 1,
		"tenant": "finance",
		"algorithm": "token_bucket",
		"scope": "client",
		"limit": 500,
		"burst": 600,
		"window": "1m",
		"enabled": true
	}`
	recCreate := makeAuthReq("POST", "/admin/v1/policies", []byte(polPayload), nil)
	if recCreate.Code != http.StatusCreated {
		t.Fatalf("expected 201 Created, got %d, body=%s", recCreate.Code, recCreate.Body.String())
	}
	etag := recCreate.Header().Get("ETag")
	if etag == "" {
		t.Fatal("missing ETag on created policy")
	}

	// 3. Get Policy (GET /admin/v1/policies/pol-billing)
	recGet := makeAuthReq("GET", "/admin/v1/policies/pol-billing", nil, nil)
	if recGet.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d, body=%s", recGet.Code, recGet.Body.String())
	}

	// 4. Test If-None-Match cache validation (304 Not Modified)
	recNotMod := makeAuthReq("GET", "/admin/v1/policies/pol-billing", nil, map[string]string{"If-None-Match": etag})
	if recNotMod.Code != http.StatusNotModified {
		t.Fatalf("expected 304 Not Modified, got %d", recNotMod.Code)
	}

	// 5. Update Policy with If-Match (PUT /admin/v1/policies/pol-billing)
	updatePayload := `{
		"id": "pol-billing",
		"name": "Billing Tier Limit Updated",
		"version": 1,
		"tenant": "finance",
		"algorithm": "token_bucket",
		"scope": "client",
		"limit": 800,
		"burst": 800,
		"window": "1m",
		"enabled": true
	}`
	recUpdate := makeAuthReq("PUT", "/admin/v1/policies/pol-billing", []byte(updatePayload), map[string]string{"If-Match": etag})
	if recUpdate.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on update, got %d, body=%s", recUpdate.Code, recUpdate.Body.String())
	}
	newEtag := recUpdate.Header().Get("ETag")

	// 6. Rollback Policy (POST /admin/v1/policies/pol-billing/rollback)
	rollbackPayload := `{"target_version": 1, "author": "ops", "reason": "incident rollback"}`
	recRollback := makeAuthReq("POST", "/admin/v1/policies/pol-billing/rollback", []byte(rollbackPayload), nil)
	if recRollback.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on rollback, got %d, body=%s", recRollback.Code, recRollback.Body.String())
	}

	// 7. List Policies (GET /admin/v1/policies)
	recList := makeAuthReq("GET", "/admin/v1/policies?tenant=finance", nil, nil)
	if recList.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on list, got %d", recList.Code)
	}
	var listResp map[string]any
	_ = json.Unmarshal(recList.Body.Bytes(), &listResp)
	if listResp["count"] != float64(1) {
		t.Errorf("expected 1 policy listed, got %v", listResp["count"])
	}

	// 8. Delete Policy (DELETE /admin/v1/policies/pol-billing)
	recDelete := makeAuthReq("DELETE", "/admin/v1/policies/pol-billing", nil, map[string]string{"If-Match": newEtag})
	// deletion allowed
	if recDelete.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on delete, got %d", recDelete.Code)
	}
}

func TestAdminAPICountersAndBreakers(t *testing.T) {
	admin, _, _ := setupTestAdmin(t)

	makeAuthReq := func(path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("Authorization", "Bearer test-admin-secret")
		rec := httptest.NewRecorder()
		admin.ServeHTTP(rec, req)
		return rec
	}

	// Counters peek
	recCounters := makeAuthReq("/admin/v1/counters?key=test-key&limit=50&window=1m")
	if recCounters.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from counters peek, got %d, body=%s", recCounters.Code, recCounters.Body.String())
	}

	// Breakers list
	recBreakers := makeAuthReq("/admin/v1/breakers")
	if recBreakers.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from breakers status, got %d", recBreakers.Code)
	}
}
