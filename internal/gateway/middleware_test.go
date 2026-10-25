package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/identity"
	"rlgw/internal/policy"
	"rlgw/internal/store"
	"rlgw/internal/store/memory"
)

func TestRecoveryMiddleware(t *testing.T) {
	panicHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("critical database connection blowout")
	})

	mw := RecoveryMiddleware(nil)(panicHandler)

	req := httptest.NewRequest("GET", "/panic", nil)
	rec := httptest.NewRecorder()

	// Must not crash the process
	mw.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 Internal Server Error, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "internal_server_error") {
		t.Errorf("expected json error response, got %s", rec.Body.String())
	}
}

func TestStandaloneLimiterLibraryMode(t *testing.T) {
	// Build policy: max 2 requests per minute
	pol := policy.Policy{
		ID:        "pol-library-demo",
		Tenant:    "acme",
		Scope:     policy.ScopeClient,
		Algorithm: policy.AlgorithmTokenBucket,
		Limit:     2,
		Burst:     2,
		Window:    time.Minute,
		Priority:  1,
		Enabled:   true,
		Match:     policy.MatchSpec{RoutePattern: "/**"},
	}

	fakeClk := clock.NewFakeClock(time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC))
	snap, err := policy.CompileSnapshot("prod", 1, []policy.Policy{pol}, nil, fakeClk)
	if err != nil {
		t.Fatalf("failed to compile snapshot: %v", err)
	}

	memStore := memory.NewMemoryStore(1000)
	opts := LimiterOptions{
		Store:            memStore,
		SnapshotProvider: func() *policy.PolicySnapshot { return snap },
		Clock:            fakeClk,
	}

	// Create identity resolver with API key lookup
	keyLookup := identity.NewInMemoryKeyLookup()
	keyLookup.RegisterKey(identity.APIKey{KeyID: "demo", Secret: "secret123", ClientID: "app-client", Tenant: "acme"})
	apiKeySource := identity.NewAPIKeySource(keyLookup, "X-API-Key")
	ipSource := identity.NewIPSource(identity.NewUntrustedProxyChecker(), identity.DefaultIPv6PrefixBits)
	resolver := identity.NewResolver([]identity.IdentitySource{apiKeySource}, ipSource, nil)

	// Standalone library middleware wrapping a microservice backend
	backendMux := http.NewServeMux()
	backendMux.HandleFunc("/api/hello", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"message":"hello world"}`))
	})

	limiterMw := NewStandaloneLimiterMiddleware(opts, resolver)
	appHandler := limiterMw(backendMux)

	makeReq := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/hello", nil)
		req.Header.Set("X-API-Key", "rlk_demo_secret123")
		rec := httptest.NewRecorder()
		appHandler.ServeHTTP(rec, req)
		return rec
	}

	// Req 1: OK (200), Remaining 1
	rec1 := makeReq()
	if rec1.Code != http.StatusOK {
		t.Fatalf("request 1 failed: status=%d, body=%s", rec1.Code, rec1.Body.String())
	}
	if rec1.Header().Get("X-Request-Id") == "" {
		t.Errorf("expected X-Request-Id header injected")
	}
	if rec1.Header().Get("RateLimit-Remaining") != "1" {
		t.Errorf("expected remaining 1, got %q", rec1.Header().Get("RateLimit-Remaining"))
	}

	// Req 2: OK (200), Remaining 0
	rec2 := makeReq()
	if rec2.Code != http.StatusOK {
		t.Fatalf("request 2 failed: status=%d", rec2.Code)
	}
	if rec2.Header().Get("RateLimit-Remaining") != "0" {
		t.Errorf("expected remaining 0, got %q", rec2.Header().Get("RateLimit-Remaining"))
	}

	// Req 3: 429 Too Many Requests
	rec3 := makeReq()
	if rec3.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 Too Many Requests, got %d", rec3.Code)
	}
	if rec3.Header().Get("Retry-After") == "" {
		t.Errorf("missing Retry-After header on 429 response")
	}
	if !strings.Contains(rec3.Body.String(), "too_many_requests") {
		t.Errorf("expected 429 json body, got: %s", rec3.Body.String())
	}
}

func TestCircuitBreakerMiddlewareRefundsQuotaOnTrip(t *testing.T) {
	fakeClk := clock.NewFakeClock(time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC))

	pol := policy.Policy{
		ID:        "pol-trip",
		Tenant:    "acme",
		Scope:     policy.ScopeClient,
		Algorithm: policy.AlgorithmTokenBucket,
		Limit:     5,
		Burst:     5,
		Window:    time.Minute,
		Priority:  1,
		Enabled:   true,
		Match:     policy.MatchSpec{RoutePattern: "/**"},
	}
	snap, _ := policy.CompileSnapshot("prod", 1, []policy.Policy{pol}, nil, fakeClk)
	memStore := memory.NewMemoryStore(1000)

	// Proxy manager with circuit breaker pre-tripped
	breakerReg := NewBreakerRegistry(fakeClk, nil)
	cb := breakerReg.GetOrCreate("payment-service", BreakerConfig{ConsecutiveFailures: 1})
	cb.RecordFailure() // Trips to Open

	upstreams := []UpstreamConfig{{ID: "payment-service", Targets: []string{"http://127.0.0.1:9099"}}}
	routes := []RouteConfig{{ID: "r", RoutePattern: "/**", UpstreamID: "payment-service"}}

	pm, err := NewProxyManager(upstreams, routes, nil, breakerReg, nil, fakeClk)
	if err != nil {
		t.Fatalf("failed to create proxy manager: %v", err)
	}

	limiter := NewRateLimiter(LimiterOptions{
		Store:            memStore,
		SnapshotProvider: func() *policy.PolicySnapshot { return snap },
		Clock:            fakeClk,
	})

	id := &identity.Identity{Tenant: "acme", ClientID: "c1"}

	// Chain: Limiter -> Breaker -> Dummy Backend
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	pipeline := LimiterMiddleware(limiter)(CircuitBreakerMiddleware(pm)(backend))

	req := httptest.NewRequest("GET", "/payment/charge", nil)
	ctx := context.WithValue(req.Context(), contextKeyIdentity, id)
	rec := httptest.NewRecorder()

	pipeline.ServeHTTP(rec, req.WithContext(ctx))

	// Breaker should have rejected with 503
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 Service Unavailable from breaker, got %d", rec.Code)
	}

	// Verify that the rate limit quota was REFUNDED! Remaining must still be 5!
	res, _ := snap.Resolve(policy.RouteRequest{Method: "GET", Path: "/payment/charge"}, id.ToRequestIdentity())
	spec := store.AlgoSpec{Algorithm: string(pol.Algorithm), Limit: pol.Limit, Window: pol.Window, Burst: pol.Burst}
	dec, _ := memStore.Peek(context.Background(), res[0].BinaryKey, spec, fakeClk.Now())
	if dec.Remaining != 5 {
		t.Fatalf("Rate limit counter was not refunded on circuit breaker trip! Remaining = %d, expected 5", dec.Remaining)
	}
}
