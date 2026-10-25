package obs

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"rlgw/internal/errors"
)

// PrometheusRegistry provides in-memory thread-safe metric collection with Prometheus text exposition.
type PrometheusRegistry struct {
	mu sync.RWMutex

	// Counters: metricKey -> count
	counters map[string]*atomic.Int64

	// Gauges: metricKey -> value
	gauges map[string]*atomic.Int64

	// Duration summaries: count and sum (nanoseconds)
	durationsCount map[string]*atomic.Int64
	durationsSumNs map[string]*atomic.Int64
}

// NewPrometheusRegistry constructs an initialized PrometheusRegistry.
func NewPrometheusRegistry() *PrometheusRegistry {
	return &PrometheusRegistry{
		counters:       make(map[string]*atomic.Int64),
		gauges:         make(map[string]*atomic.Int64),
		durationsCount: make(map[string]*atomic.Int64),
		durationsSumNs: make(map[string]*atomic.Int64),
	}
}

func (p *PrometheusRegistry) getOrCreateCounter(key string) *atomic.Int64 {
	p.mu.RLock()
	c, ok := p.counters[key]
	p.mu.RUnlock()
	if ok {
		return c
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if c, ok := p.counters[key]; ok {
		return c
	}
	c = &atomic.Int64{}
	p.counters[key] = c
	return c
}

func (p *PrometheusRegistry) getOrCreateGauge(key string) *atomic.Int64 {
	p.mu.RLock()
	g, ok := p.gauges[key]
	p.mu.RUnlock()
	if ok {
		return g
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if g, ok := p.gauges[key]; ok {
		return g
	}
	g = &atomic.Int64{}
	p.gauges[key] = g
	return g
}

// RecordDecision logs a rate-limiting decision outcome.
func (p *PrometheusRegistry) RecordDecision(_ context.Context, d DecisionRecord) {
	tenant := d.Tenant
	if tenant == "" {
		tenant = "global"
	}
	policyID := d.PolicyID
	if policyID == "" {
		policyID = "unknown"
	}
	allowedStr := strconv.FormatBool(d.Allowed)
	key := fmt.Sprintf(`rate_limit_decisions_total{allowed="%s",policy="%s",tenant="%s"}`, allowedStr, policyID, tenant)
	p.getOrCreateCounter(key).Add(1)
}

// RecordResolution records identity resolution timing and status.
func (p *PrometheusRegistry) RecordResolution(_ context.Context, source string, success bool, _ time.Duration) {
	succStr := strconv.FormatBool(success)
	key := fmt.Sprintf(`identity_resolutions_total{source="%s",success="%s"}`, source, succStr)
	p.getOrCreateCounter(key).Add(1)
}

// RecordStoreOp records a counter backend storage operation.
func (p *PrometheusRegistry) RecordStoreOp(_ context.Context, op string, success bool, _ time.Duration) {
	succStr := strconv.FormatBool(success)
	key := fmt.Sprintf(`rate_limit_store_ops_total{op="%s",success="%s"}`, op, succStr)
	p.getOrCreateCounter(key).Add(1)
}

// RecordError records an internal error code.
func (p *PrometheusRegistry) RecordError(_ context.Context, code errors.ErrorCode) {
	key := fmt.Sprintf(`rate_limit_errors_total{code="%s"}`, code)
	p.getOrCreateCounter(key).Add(1)
}

// RecordGatewayRequest records an inbound HTTP request processed by the gateway.
func (p *PrometheusRegistry) RecordGatewayRequest(method string, status int, duration time.Duration) {
	key := fmt.Sprintf(`gateway_requests_total{method="%s",status="%d"}`, method, status)
	p.getOrCreateCounter(key).Add(1)

	durKey := fmt.Sprintf(`gateway_request_duration_seconds{method="%s"}`, method)
	p.mu.Lock()
	c, ok := p.durationsCount[durKey]
	if !ok {
		c = &atomic.Int64{}
		p.durationsCount[durKey] = c
	}
	s, ok := p.durationsSumNs[durKey]
	if !ok {
		s = &atomic.Int64{}
		p.durationsSumNs[durKey] = s
	}
	p.mu.Unlock()

	c.Add(1)
	s.Add(duration.Nanoseconds())
}

// RecordBreakerTrip records a circuit breaker trip on an upstream.
func (p *PrometheusRegistry) RecordBreakerTrip(upstream string) {
	key := fmt.Sprintf(`circuit_breaker_trips_total{upstream="%s"}`, upstream)
	p.getOrCreateCounter(key).Add(1)
}

// RecordBreakerState sets the current breaker state (0=closed, 1=half-open, 2=open).
func (p *PrometheusRegistry) RecordBreakerState(upstream string, stateVal int64) {
	key := fmt.Sprintf(`circuit_breaker_state{upstream="%s"}`, upstream)
	p.getOrCreateGauge(key).Store(stateVal)
}

// RecordFailOpen records a fail-open decision due to store error.
func (p *PrometheusRegistry) RecordFailOpen(policyID string) {
	key := fmt.Sprintf(`rate_limit_fail_open_total{policy="%s"}`, policyID)
	p.getOrCreateCounter(key).Add(1)
}

// WritePrometheus writes the registered metrics in standard Prometheus exposition format.
func (p *PrometheusRegistry) WritePrometheus(w io.Writer) error {
	p.mu.RLock()
	defer p.mu.RUnlock()

	var b strings.Builder

	// Write counters
	b.WriteString("# HELP rate_limit_decisions_total Total rate limiting decisions\n")
	b.WriteString("# TYPE rate_limit_decisions_total counter\n")
	b.WriteString("# HELP gateway_requests_total Total gateway requests handled\n")
	b.WriteString("# TYPE gateway_requests_total counter\n")
	b.WriteString("# HELP circuit_breaker_trips_total Total circuit breaker trips\n")
	b.WriteString("# TYPE circuit_breaker_trips_total counter\n")
	b.WriteString("# HELP rate_limit_fail_open_total Total rate limit fail-open events\n")
	b.WriteString("# TYPE rate_limit_fail_open_total counter\n")

	for k, v := range p.counters {
		b.WriteString(k)
		b.WriteByte(' ')
		b.WriteString(strconv.FormatInt(v.Load(), 10))
		b.WriteByte('\n')
	}

	// Write gauges
	b.WriteString("# HELP circuit_breaker_state Circuit breaker state (0=closed, 1=half_open, 2=open)\n")
	b.WriteString("# TYPE circuit_breaker_state gauge\n")
	for k, v := range p.gauges {
		b.WriteString(k)
		b.WriteByte(' ')
		b.WriteString(strconv.FormatInt(v.Load(), 10))
		b.WriteByte('\n')
	}

	// Write duration summaries
	for k, count := range p.durationsCount {
		sumNs := p.durationsSumNs[k]
		if sumNs == nil {
			continue
		}
		cVal := count.Load()
		sVal := float64(sumNs.Load()) / 1e9

		// k is e.g. gateway_request_duration_seconds{method="GET"}
		prefix := k
		labels := ""
		if idx := strings.IndexByte(k, '{'); idx != -1 {
			prefix = k[:idx]
			labels = k[idx:]
		}

		// Count
		b.WriteString(prefix)
		b.WriteString("_count")
		b.WriteString(labels)
		b.WriteByte(' ')
		b.WriteString(strconv.FormatInt(cVal, 10))
		b.WriteByte('\n')

		// Sum
		b.WriteString(prefix)
		b.WriteString("_sum")
		b.WriteString(labels)
		b.WriteByte(' ')
		b.WriteString(fmt.Sprintf("%.6f", sVal))
		b.WriteByte('\n')
	}

	_, err := io.WriteString(w, b.String())
	return err
}
