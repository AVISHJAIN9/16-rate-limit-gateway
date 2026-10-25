package gateway

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/errors"
	"rlgw/internal/obs"
)

// Hop-by-hop headers to strip as defined in RFC 7230 section 6.1
var hopByHopHeaders = []string{
	"Connection",
	"Keep-Alive",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"Te",
	"Trailers",
	"Transfer-Encoding",
}

// UpstreamConfig defines an upstream cluster and its timeout/breaker policies.
type UpstreamConfig struct {
	ID             string        `json:"id" yaml:"id"`
	Targets        []string      `json:"targets" yaml:"targets"`
	CircuitBreaker BreakerConfig `json:"circuit_breaker" yaml:"circuit_breaker"`
	Timeouts       TimeoutConfig `json:"timeouts" yaml:"timeouts"`
}

// TimeoutConfig specifies fine-grained timeouts for upstream transport connections.
type TimeoutConfig struct {
	ConnectTimeout        time.Duration `json:"connect_timeout" yaml:"connect_timeout"`
	TLSHandshakeTimeout   time.Duration `json:"tls_handshake_timeout" yaml:"tls_handshake_timeout"`
	ResponseHeaderTimeout time.Duration `json:"response_header_timeout" yaml:"response_header_timeout"`
	IdleConnTimeout       time.Duration `json:"idle_conn_timeout" yaml:"idle_conn_timeout"`
	OverallDeadline       time.Duration `json:"overall_deadline" yaml:"overall_deadline"`
}

// DefaultTimeoutConfig provides resilient connection timeout defaults.
func DefaultTimeoutConfig() TimeoutConfig {
	return TimeoutConfig{
		ConnectTimeout:        2 * time.Second,
		TLSHandshakeTimeout:   2 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		OverallDeadline:       10 * time.Second,
	}
}

// RouteConfig maps route patterns to an upstream with per-route overrides.
type RouteConfig struct {
	ID           string        `json:"id" yaml:"id"`
	RoutePattern string        `json:"route_pattern" yaml:"route_pattern"`
	Methods      []string      `json:"methods,omitempty" yaml:"methods,omitempty"`
	UpstreamID   string        `json:"upstream_id" yaml:"upstream_id"`
	Timeout      time.Duration `json:"timeout,omitempty" yaml:"timeout,omitempty"`
	MaxBodyBytes int64         `json:"max_body_bytes,omitempty" yaml:"max_body_bytes,omitempty"`
}

// UpstreamCluster manages a pool of parsed backend targets with round-robin load balancing.
type UpstreamCluster struct {
	ID          string
	Targets     []*url.URL
	Breaker     *CircuitBreaker
	Timeouts    TimeoutConfig
	counter     atomic.Uint64
}

// NextTarget picks the next available target using atomic round-robin.
func (u *UpstreamCluster) NextTarget() (*url.URL, error) {
	if len(u.Targets) == 0 {
		return nil, errors.New(errors.ErrCodeBadGateway, fmt.Sprintf("no targets configured for upstream %q", u.ID))
	}
	if len(u.Targets) == 1 {
		return u.Targets[0], nil
	}
	idx := u.counter.Add(1) - 1
	return u.Targets[idx%uint64(len(u.Targets))], nil
}

// ProxyManager orchestrates upstream reverse proxy forwarding.
type ProxyManager struct {
	upstreams    map[string]*UpstreamCluster
	routes       []RouteConfig
	normalizer   *Normalizer
	breakerReg   *BreakerRegistry
	transport    *http.Transport
	reverseProxy *httputil.ReverseProxy
	recorder     *obs.PrometheusRegistry
	clk          clock.Clock
}

// NewProxyManager creates a tuned streaming reverse proxy manager.
func NewProxyManager(
	upstreamsCfg []UpstreamConfig,
	routesCfg []RouteConfig,
	normalizer *Normalizer,
	breakerReg *BreakerRegistry,
	recorder *obs.PrometheusRegistry,
	clk clock.Clock,
) (*ProxyManager, error) {
	if normalizer == nil {
		normalizer = NewNormalizer(DefaultNormalizerConfig())
	}
	if clk == nil {
		clk = clock.NewRealClock()
	}

	clusters := make(map[string]*UpstreamCluster, len(upstreamsCfg))
	for _, uc := range upstreamsCfg {
		if strings.TrimSpace(uc.ID) == "" {
			return nil, errors.New(errors.ErrCodeConfigInvalid, "upstream id cannot be empty")
		}
		var parsedURLs []*url.URL
		for _, raw := range uc.Targets {
			parsed, err := url.Parse(raw)
			if err != nil || parsed.Host == "" {
				return nil, errors.New(errors.ErrCodeConfigInvalid, fmt.Sprintf("invalid upstream target URL %q: %v", raw, err))
			}
			parsedURLs = append(parsedURLs, parsed)
		}

		breakerCfg := uc.CircuitBreaker
		if breakerCfg.ConsecutiveFailures == 0 {
			breakerCfg = DefaultBreakerConfig()
		}

		var cb *CircuitBreaker
		if breakerReg != nil {
			cb = breakerReg.GetOrCreate(uc.ID, breakerCfg)
		} else {
			cb = NewCircuitBreaker(uc.ID, breakerCfg, clk, recorder)
		}

		clusters[uc.ID] = &UpstreamCluster{
			ID:       uc.ID,
			Targets:  parsedURLs,
			Breaker:  cb,
			Timeouts: uc.Timeouts,
		}
	}

	// Tuned HTTP Transport for connection pooling and high throughput
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   2 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          1000,
		MaxIdleConnsPerHost:   100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   2 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
	}

	pm := &ProxyManager{
		upstreams:  clusters,
		routes:     routesCfg,
		normalizer: normalizer,
		breakerReg: breakerReg,
		transport:  transport,
		recorder:   recorder,
		clk:        clk,
	}

	// Initialize ReverseProxy
	rp := &httputil.ReverseProxy{
		Director:       pm.director,
		Transport:      pm,
		FlushInterval:  -1, // Streaming mode: flush body immediately
		ErrorHandler:   pm.errorHandler,
	}
	pm.reverseProxy = rp

	return pm, nil
}

// FindRoute matches the normalized path and method against configured routes.
func (pm *ProxyManager) FindRoute(method, normalizedPath string) *RouteConfig {
	for i := range pm.routes {
		r := &pm.routes[i]
		if len(r.Methods) > 0 {
			matchedMethod := false
			for _, m := range r.Methods {
				if strings.EqualFold(m, method) {
					matchedMethod = true
					break
				}
			}
			if !matchedMethod {
				continue
			}
		}

		// Simple wildcard matching for route patterns
		pat := r.RoutePattern
		if pat == "" || pat == "/**" || pat == "/*" {
			return r
		}
		if strings.HasSuffix(pat, "/**") {
			prefix := strings.TrimSuffix(pat, "/**")
			if strings.HasPrefix(normalizedPath, prefix) {
				return r
			}
		} else if strings.HasSuffix(pat, "/*") {
			prefix := strings.TrimSuffix(pat, "/*")
			if strings.HasPrefix(normalizedPath, prefix) {
				return r
			}
		} else if strings.EqualFold(pat, normalizedPath) {
			return r
		}
	}
	return nil
}

// GetUpstream returns the upstream cluster for upstreamID.
func (pm *ProxyManager) GetUpstream(upstreamID string) *UpstreamCluster {
	return pm.upstreams[upstreamID]
}

// director modifies the outbound request headers and target URL.
func (pm *ProxyManager) director(req *http.Request) {
	// Preserve raw path or forward normalized path according to config
	canonicalPath := req.URL.Path
	if !pm.normalizer.PreserveRawPath() {
		if norm, err := pm.normalizer.Normalize(req.URL.Path); err == nil {
			canonicalPath = norm
		}
	}

	route := pm.FindRoute(req.Method, canonicalPath)
	var cluster *UpstreamCluster
	if route != nil {
		cluster = pm.upstreams[route.UpstreamID]
	}
	if cluster == nil && len(pm.upstreams) == 1 {
		// Fallback to sole configured upstream
		for _, u := range pm.upstreams {
			cluster = u
			break
		}
	}

	if cluster != nil {
		if target, err := cluster.NextTarget(); err == nil {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.Host = target.Host
		}
	}

	// Hop-by-hop header stripping (keep Upgrade if WebSocket)
	isWebSocket := strings.EqualFold(req.Header.Get("Upgrade"), "websocket") &&
		strings.Contains(strings.ToLower(req.Header.Get("Connection")), "upgrade")

	for _, h := range hopByHopHeaders {
		if isWebSocket && (strings.EqualFold(h, "Upgrade") || strings.EqualFold(h, "Connection")) {
			continue
		}
		req.Header.Del(h)
	}



	// X-Forwarded-Proto
	if req.TLS != nil {
		req.Header.Set("X-Forwarded-Proto", "https")
	} else {
		req.Header.Set("X-Forwarded-Proto", "http")
	}

	// X-Forwarded-Host
	if req.Header.Get("X-Forwarded-Host") == "" && req.Host != "" {
		req.Header.Set("X-Forwarded-Host", req.Host)
	}

	// Via
	if via := req.Header.Get("Via"); via != "" {
		req.Header.Set("Via", via+", 1.1 rlgw")
	} else {
		req.Header.Set("Via", "1.1 rlgw")
	}
}

// RoundTrip executes the round trip through pm.transport while measuring latency and reporting breaker status.
func (pm *ProxyManager) RoundTrip(req *http.Request) (*http.Response, error) {
	// Identify upstream from host or route
	var cluster *UpstreamCluster
	for _, u := range pm.upstreams {
		for _, t := range u.Targets {
			if t.Host == req.URL.Host {
				cluster = u
				break
			}
		}
		if cluster != nil {
			break
		}
	}
	if cluster == nil && len(pm.upstreams) == 1 {
		for _, u := range pm.upstreams {
			cluster = u
			break
		}
	}

	// Circuit breaker check
	if cluster != nil && cluster.Breaker != nil {
		if !cluster.Breaker.Allow() {
			return nil, errors.New(errors.ErrCodeBadGateway, fmt.Sprintf("circuit breaker open for upstream %q", cluster.ID))
		}
	}

	start := pm.clk.Now()
	resp, err := pm.transport.RoundTrip(req)
	duration := pm.clk.Now().Sub(start)

	if cluster != nil && cluster.Breaker != nil {
		if err != nil || (resp != nil && resp.StatusCode >= 500) {
			cluster.Breaker.RecordFailure()
		} else {
			cluster.Breaker.RecordSuccess(duration)
		}
	}

	return resp, err
}

// errorHandler translates network and context errors into 502/504 JSON responses.
func (pm *ProxyManager) errorHandler(w http.ResponseWriter, req *http.Request, err error) {
	if errors.Is(err, context.Canceled) {
		// Client aborted request; nothing to write
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")

	if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
		w.WriteHeader(http.StatusGatewayTimeout)
		_, _ = io.WriteString(w, `{"error":"gateway_timeout","message":"Upstream request deadline exceeded"}`)
		return
	}

	// Connection refused / circuit breaker open / network errors
	w.WriteHeader(http.StatusBadGateway)
	_, _ = io.WriteString(w, fmt.Sprintf(`{"error":"bad_gateway","message":"Upstream forwarding failed: %s"}`, err.Error()))
}

// ServeHTTP proxies an inbound HTTP request to the designated upstream with timeouts and body limits.
func (pm *ProxyManager) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	canonicalPath := req.URL.Path
	if norm, err := pm.normalizer.Normalize(req.URL.Path); err == nil {
		canonicalPath = norm
	}

	route := pm.FindRoute(req.Method, canonicalPath)

	// Apply MaxBodyBytes limit if configured
	if route != nil && route.MaxBodyBytes > 0 && req.Body != nil {
		req.Body = http.MaxBytesReader(w, req.Body, route.MaxBodyBytes)
	}

	// Apply overall request timeout
	timeout := 10 * time.Second
	if route != nil && route.Timeout > 0 {
		timeout = route.Timeout
	} else if route != nil {
		if u := pm.upstreams[route.UpstreamID]; u != nil && u.Timeouts.OverallDeadline > 0 {
			timeout = u.Timeouts.OverallDeadline
		}
	}

	ctx, cancel := context.WithTimeout(req.Context(), timeout)
	defer cancel()

	pm.reverseProxy.ServeHTTP(w, req.WithContext(ctx))
}
