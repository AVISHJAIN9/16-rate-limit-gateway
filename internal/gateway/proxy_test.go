package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.uber.org/goleak"
	"rlgw/internal/clock"
)

func TestProxyRoundRobinLoadBalancing(t *testing.T) {
	var count1, count2 atomic.Int64

	// Backend 1
	backend1 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count1.Add(1)
		w.Header().Set("X-Backend", "1")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"backend":1}`))
	}))
	defer backend1.Close()

	// Backend 2
	backend2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count2.Add(1)
		w.Header().Set("X-Backend", "2")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"backend":2}`))
	}))
	defer backend2.Close()

	upstreams := []UpstreamConfig{
		{
			ID:      "test-service",
			Targets: []string{backend1.URL, backend2.URL},
		},
	}
	routes := []RouteConfig{
		{
			ID:           "test-route",
			RoutePattern: "/**",
			UpstreamID:   "test-service",
			Timeout:      5 * time.Second,
		},
	}

	norm := NewNormalizer(DefaultNormalizerConfig())
	pm, err := NewProxyManager(upstreams, routes, norm, nil, nil, clock.NewRealClock())
	if err != nil {
		t.Fatalf("failed to create proxy manager: %v", err)
	}

	// Send 10 requests: should balance equally 5 and 5
	for i := 0; i < 10; i++ {
		req := httptest.NewRequest("GET", "/test", nil)
		rec := httptest.NewRecorder()
		pm.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d failed with status %d", i, rec.Code)
		}
	}

	if count1.Load() != 5 || count2.Load() != 5 {
		t.Errorf("expected 5 requests to backend1 and 5 to backend2, got %d and %d", count1.Load(), count2.Load())
	}
}

func TestProxyHopByHopAndForwardingHeaders(t *testing.T) {
	var receivedVia, receivedXFF, receivedXFP, receivedConn, receivedUpgrade string

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedVia = r.Header.Get("Via")
		receivedXFF = r.Header.Get("X-Forwarded-For")
		receivedXFP = r.Header.Get("X-Forwarded-Proto")
		receivedConn = r.Header.Get("Connection")
		receivedUpgrade = r.Header.Get("Upgrade")
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	upstreams := []UpstreamConfig{{ID: "echo", Targets: []string{backend.URL}}}
	routes := []RouteConfig{{ID: "r1", RoutePattern: "/**", UpstreamID: "echo"}}

	pm, err := NewProxyManager(upstreams, routes, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("failed to create proxy manager: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/v1/echo", nil)
	req.RemoteAddr = "203.0.113.195:12345"
	req.Header.Set("Connection", "close")
	req.Header.Set("Keep-Alive", "timeout=5")
	req.Header.Set("X-Forwarded-For", "198.51.100.1")

	rec := httptest.NewRecorder()
	pm.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(receivedVia, "1.1 rlgw") {
		t.Errorf("missing Via header: %q", receivedVia)
	}
	if receivedXFF != "198.51.100.1, 203.0.113.195" {
		t.Errorf("unexpected X-Forwarded-For: %q", receivedXFF)
	}
	if receivedXFP != "http" {
		t.Errorf("unexpected X-Forwarded-Proto: %q", receivedXFP)
	}
	if receivedConn != "" {
		t.Errorf("hop-by-hop Connection header was not stripped: %q", receivedConn)
	}
	if receivedUpgrade != "" {
		t.Errorf("hop-by-hop Upgrade header was not stripped: %q", receivedUpgrade)
	}
}

func TestProxyTimeout504Mapping(t *testing.T) {
	// Backend hangs longer than timeout
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()

	upstreams := []UpstreamConfig{{ID: "slow", Targets: []string{backend.URL}}}
	routes := []RouteConfig{
		{
			ID:           "slow-route",
			RoutePattern: "/**",
			UpstreamID:   "slow",
			Timeout:      50 * time.Millisecond, // very short timeout
		},
	}

	pm, err := NewProxyManager(upstreams, routes, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("failed to create proxy manager: %v", err)
	}

	req := httptest.NewRequest("GET", "/slow", nil)
	rec := httptest.NewRecorder()
	pm.ServeHTTP(rec, req)

	if rec.Code != http.StatusGatewayTimeout {
		t.Errorf("expected 504 Gateway Timeout, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "gateway_timeout") {
		t.Errorf("expected gateway_timeout in body, got: %s", rec.Body.String())
	}
}

func TestProxyConnectionRefused502Mapping(t *testing.T) {
	// Target URL pointing to an inactive port
	upstreams := []UpstreamConfig{{ID: "dead", Targets: []string{"http://127.0.0.1:49999"}}}
	routes := []RouteConfig{{ID: "dead-route", RoutePattern: "/**", UpstreamID: "dead", Timeout: 1 * time.Second}}

	pm, err := NewProxyManager(upstreams, routes, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("failed to create proxy manager: %v", err)
	}

	req := httptest.NewRequest("GET", "/dead", nil)
	rec := httptest.NewRecorder()
	pm.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected 502 Bad Gateway, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "bad_gateway") {
		t.Errorf("expected bad_gateway in body, got: %s", rec.Body.String())
	}
}

func TestProxyNoGoroutineLeakOnClientAbort(t *testing.T) {
	defer goleak.VerifyNone(t)

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer backend.Close()

	upstreams := []UpstreamConfig{{ID: "abort", Targets: []string{backend.URL}}}
	routes := []RouteConfig{{ID: "r", RoutePattern: "/**", UpstreamID: "abort", Timeout: 2 * time.Second}}

	pm, err := NewProxyManager(upstreams, routes, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("failed to create proxy manager: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("GET", "/abort", nil).WithContext(ctx)
	rec := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		pm.ServeHTTP(rec, req)
		close(done)
	}()

	// Simulate client disconnecting after 20ms
	time.Sleep(20 * time.Millisecond)
	cancel()

	select {
	case <-done:
		// Succeeded
	case <-time.After(2 * time.Second):
		t.Fatal("proxy ServeHTTP did not terminate after client context cancelled")
	}

	// Close idle connections to ensure transport cleanup
	pm.transport.CloseIdleConnections()
}
