package gateway

import (
	"sync"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/obs"
)

// BreakerState represents the current state of a circuit breaker.
type BreakerState string

const (
	BreakerClosed   BreakerState = "closed"
	BreakerHalfOpen BreakerState = "half_open"
	BreakerOpen     BreakerState = "open"
)

// BreakerConfig configures thresholds and timeouts for a circuit breaker.
type BreakerConfig struct {
	ConsecutiveFailures  int           `json:"consecutive_failures" yaml:"consecutive_failures"`
	FailureRateThreshold float64       `json:"failure_rate_threshold" yaml:"failure_rate_threshold"` // e.g. 0.5 for 50%
	MinRequestsForRate   int           `json:"min_requests_for_rate" yaml:"min_requests_for_rate"`
	WindowSize           int           `json:"window_size" yaml:"window_size"`
	SlowCallDuration     time.Duration `json:"slow_call_duration" yaml:"slow_call_duration"`
	ResetTimeout         time.Duration `json:"reset_timeout" yaml:"reset_timeout"`
	HalfOpenProbes       int           `json:"half_open_probes" yaml:"half_open_probes"`
}

// DefaultBreakerConfig returns robust default circuit breaker parameters.
func DefaultBreakerConfig() BreakerConfig {
	return BreakerConfig{
		ConsecutiveFailures:  5,
		FailureRateThreshold: 0.5,
		MinRequestsForRate:   10,
		WindowSize:           20,
		SlowCallDuration:     2 * time.Second,
		ResetTimeout:         5 * time.Second,
		HalfOpenProbes:       3,
	}
}

// BreakerStats exposes current telemetry metrics for a circuit breaker.
type BreakerStats struct {
	UpstreamID          string       `json:"upstream_id"`
	State               BreakerState `json:"state"`
	ConsecutiveFailures int          `json:"consecutive_failures"`
	ConsecutiveSuccesses int         `json:"consecutive_successes"`
	TotalRequests       int64        `json:"total_requests"`
	TotalFailures       int64        `json:"total_failures"`
	TotalTrips          int64        `json:"total_trips"`
	LastStateChange     time.Time    `json:"last_state_change"`
}

// CircuitBreaker guards an upstream service by rejecting requests during persistent failure states.
type CircuitBreaker struct {
	mu         sync.RWMutex
	upstreamID string
	cfg        BreakerConfig
	clk        clock.Clock
	recorder   *obs.PrometheusRegistry

	state               BreakerState
	consecutiveFailures int
	consecutiveSuccesses int
	totalRequests       int64
	totalFailures       int64
	totalTrips          int64
	lastStateChange     time.Time
	openedAt            time.Time

	// Ring buffer for sliding window failure rate
	window     []bool // true = failure, false = success
	windowHead int
	windowSize int
}

// NewCircuitBreaker constructs a CircuitBreaker.
func NewCircuitBreaker(upstreamID string, cfg BreakerConfig, clk clock.Clock, recorder *obs.PrometheusRegistry) *CircuitBreaker {
	if cfg.ConsecutiveFailures <= 0 {
		cfg.ConsecutiveFailures = 5
	}
	if cfg.WindowSize <= 0 {
		cfg.WindowSize = 20
	}
	if cfg.MinRequestsForRate <= 0 {
		cfg.MinRequestsForRate = 10
	}
	if cfg.ResetTimeout <= 0 {
		cfg.ResetTimeout = 5 * time.Second
	}
	if cfg.HalfOpenProbes <= 0 {
		cfg.HalfOpenProbes = 3
	}
	if clk == nil {
		clk = clock.NewRealClock()
	}

	return &CircuitBreaker{
		upstreamID: upstreamID,
		cfg:        cfg,
		clk:        clk,
		recorder:   recorder,
		state:      BreakerClosed,
		lastStateChange: clk.Now(),
		window:     make([]bool, cfg.WindowSize),
	}
}

// Allow reports whether a call to the upstream should be permitted through.
func (cb *CircuitBreaker) Allow() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	now := cb.clk.Now()

	switch cb.state {
	case BreakerClosed:
		return true

	case BreakerOpen:
		// Check if reset timeout elapsed to transition to half-open
		if now.Sub(cb.openedAt) >= cb.cfg.ResetTimeout {
			cb.state = BreakerHalfOpen
			cb.consecutiveSuccesses = 0
			cb.lastStateChange = now
			if cb.recorder != nil {
				cb.recorder.RecordBreakerState(cb.upstreamID, 1)
			}
			return true
		}
		return false

	case BreakerHalfOpen:
		// In half-open, allow up to HalfOpenProbes concurrent/sequential test calls
		if cb.consecutiveSuccesses < cb.cfg.HalfOpenProbes {
			return true
		}
		return false
	}

	return true
}

// RecordSuccess records a successful call to the upstream.
func (cb *CircuitBreaker) RecordSuccess(duration time.Duration) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	// Slow call counting: calls taking longer than SlowCallDuration count as failures
	if cb.cfg.SlowCallDuration > 0 && duration >= cb.cfg.SlowCallDuration {
		cb.recordFailureLocked()
		return
	}

	cb.totalRequests++
	cb.consecutiveFailures = 0

	// Update sliding window
	cb.pushWindowLocked(false)

	if cb.state == BreakerHalfOpen {
		cb.consecutiveSuccesses++
		if cb.consecutiveSuccesses >= cb.cfg.HalfOpenProbes {
			// All probes succeeded: heal back to Closed!
			cb.state = BreakerClosed
			cb.consecutiveSuccesses = 0
			cb.lastStateChange = cb.clk.Now()
			cb.resetWindowLocked()
			if cb.recorder != nil {
				cb.recorder.RecordBreakerState(cb.upstreamID, 0)
			}
		}
	}
}

// RecordFailure records a failed call (e.g. 502, 503, 504, network error, or slow call).
func (cb *CircuitBreaker) RecordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	cb.recordFailureLocked()
}

func (cb *CircuitBreaker) recordFailureLocked() {
	cb.totalRequests++
	cb.totalFailures++
	cb.consecutiveFailures++
	now := cb.clk.Now()

	cb.pushWindowLocked(true)

	if cb.state == BreakerHalfOpen {
		// Probe failed in half-open: trip back to Open immediately!
		cb.tripLocked(now)
		return
	}

	if cb.state == BreakerClosed {
		// 1. Consecutive failure trigger
		if cb.consecutiveFailures >= cb.cfg.ConsecutiveFailures {
			cb.tripLocked(now)
			return
		}

		// 2. Failure rate trigger
		if cb.cfg.FailureRateThreshold > 0 && cb.windowSize >= cb.cfg.MinRequestsForRate {
			failureCount := 0
			for i := 0; i < cb.windowSize; i++ {
				if cb.window[i] {
					failureCount++
				}
			}
			rate := float64(failureCount) / float64(cb.windowSize)
			if rate >= cb.cfg.FailureRateThreshold {
				cb.tripLocked(now)
				return
			}
		}
	}
}

func (cb *CircuitBreaker) tripLocked(now time.Time) {
	cb.state = BreakerOpen
	cb.openedAt = now
	cb.lastStateChange = now
	cb.consecutiveSuccesses = 0
	cb.totalTrips++
	if cb.recorder != nil {
		cb.recorder.RecordBreakerTrip(cb.upstreamID)
		cb.recorder.RecordBreakerState(cb.upstreamID, 2)
	}
}

func (cb *CircuitBreaker) pushWindowLocked(failed bool) {
	cb.window[cb.windowHead] = failed
	cb.windowHead = (cb.windowHead + 1) % len(cb.window)
	if cb.windowSize < len(cb.window) {
		cb.windowSize++
	}
}

func (cb *CircuitBreaker) resetWindowLocked() {
	cb.windowHead = 0
	cb.windowSize = 0
	for i := range cb.window {
		cb.window[i] = false
	}
}

// State returns current BreakerState.
func (cb *CircuitBreaker) State() BreakerState {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	return cb.state
}

// Stats returns a snapshot of breaker telemetry.
func (cb *CircuitBreaker) Stats() BreakerStats {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	return BreakerStats{
		UpstreamID:           cb.upstreamID,
		State:                cb.state,
		ConsecutiveFailures:  cb.consecutiveFailures,
		ConsecutiveSuccesses: cb.consecutiveSuccesses,
		TotalRequests:        cb.totalRequests,
		TotalFailures:        cb.totalFailures,
		TotalTrips:           cb.totalTrips,
		LastStateChange:      cb.lastStateChange,
	}
}

// BreakerRegistry manages all upstream circuit breakers.
type BreakerRegistry struct {
	mu       sync.RWMutex
	breakers map[string]*CircuitBreaker
	clk      clock.Clock
	recorder *obs.PrometheusRegistry
}

// NewBreakerRegistry constructs a BreakerRegistry.
func NewBreakerRegistry(clk clock.Clock, recorder *obs.PrometheusRegistry) *BreakerRegistry {
	return &BreakerRegistry{
		breakers: make(map[string]*CircuitBreaker),
		clk:      clk,
		recorder: recorder,
	}
}

// GetOrCreate returns the circuit breaker for upstreamID, creating one with cfg if absent.
func (r *BreakerRegistry) GetOrCreate(upstreamID string, cfg BreakerConfig) *CircuitBreaker {
	r.mu.RLock()
	cb, ok := r.breakers[upstreamID]
	r.mu.RUnlock()
	if ok {
		return cb
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if cb, ok := r.breakers[upstreamID]; ok {
		return cb
	}

	cb = NewCircuitBreaker(upstreamID, cfg, r.clk, r.recorder)
	r.breakers[upstreamID] = cb
	return cb
}

// ListStats returns stats for all registered breakers.
func (r *BreakerRegistry) ListStats() []BreakerStats {
	r.mu.RLock()
	defer r.mu.RUnlock()
	stats := make([]BreakerStats, 0, len(r.breakers))
	for _, cb := range r.breakers {
		stats = append(stats, cb.Stats())
	}
	return stats
}
