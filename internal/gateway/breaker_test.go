package gateway

import (
	"testing"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/obs"
)

func TestCircuitBreakerConsecutiveFailuresAndHealing(t *testing.T) {
	fakeClk := clock.NewFakeClock(time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC))
	rec := obs.NewPrometheusRegistry()

	cfg := BreakerConfig{
		ConsecutiveFailures:  3,
		FailureRateThreshold: 0.5,
		ResetTimeout:         10 * time.Second,
		HalfOpenProbes:       2,
		SlowCallDuration:     1 * time.Second,
	}

	cb := NewCircuitBreaker("upstream-payment", cfg, fakeClk, rec)

	// Initial state: Closed
	if state := cb.State(); state != BreakerClosed {
		t.Fatalf("expected BreakerClosed, got %s", state)
	}
	if !cb.Allow() {
		t.Fatal("expected initial Allow() == true")
	}

	// 2 failures: still closed
	cb.RecordFailure()
	cb.RecordFailure()
	if cb.State() != BreakerClosed {
		t.Fatalf("expected still closed after 2 failures, got %s", cb.State())
	}

	// 3rd failure: trips to Open!
	cb.RecordFailure()
	if cb.State() != BreakerOpen {
		t.Fatalf("expected BreakerOpen after 3 consecutive failures, got %s", cb.State())
	}
	if cb.Allow() {
		t.Fatal("expected Allow() == false when BreakerOpen")
	}

	// Advance clock by 5s: still within reset timeout (10s), remain Open
	fakeClk.Advance(5 * time.Second)
	if cb.Allow() {
		t.Fatal("expected Allow() == false before reset timeout expires")
	}

	// Advance clock past 10s: should allow probe and transition to HalfOpen
	fakeClk.Advance(6 * time.Second)
	if !cb.Allow() {
		t.Fatal("expected Allow() == true for half-open probe after reset timeout")
	}
	if cb.State() != BreakerHalfOpen {
		t.Fatalf("expected BreakerHalfOpen, got %s", cb.State())
	}

	// Probe 1 succeeds
	cb.RecordSuccess(50 * time.Millisecond)
	if cb.State() != BreakerHalfOpen {
		t.Fatalf("expected still HalfOpen after 1 probe success, got %s", cb.State())
	}

	// Probe 2 succeeds: heals back to Closed!
	cb.RecordSuccess(50 * time.Millisecond)
	if cb.State() != BreakerClosed {
		t.Fatalf("expected healed back to BreakerClosed after 2 probe successes, got %s", cb.State())
	}
	if !cb.Allow() {
		t.Fatal("expected Allow() == true in Closed state")
	}
}

func TestCircuitBreakerProbeFailureReTrips(t *testing.T) {
	fakeClk := clock.NewFakeClock(time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC))
	cfg := BreakerConfig{
		ConsecutiveFailures: 2,
		ResetTimeout:        5 * time.Second,
		HalfOpenProbes:      2,
	}

	cb := NewCircuitBreaker("upstream-auth", cfg, fakeClk, nil)
	cb.RecordFailure()
	cb.RecordFailure()
	if cb.State() != BreakerOpen {
		t.Fatalf("expected Open, got %s", cb.State())
	}

	// Advance past reset timeout -> HalfOpen
	fakeClk.Advance(6 * time.Second)
	if !cb.Allow() {
		t.Fatal("expected Allow() == true for probe")
	}
	if cb.State() != BreakerHalfOpen {
		t.Fatalf("expected HalfOpen, got %s", cb.State())
	}

	// Probe fails -> trips immediately back to Open
	cb.RecordFailure()
	if cb.State() != BreakerOpen {
		t.Fatalf("expected immediate re-trip to Open on probe failure, got %s", cb.State())
	}
	if cb.Allow() {
		t.Fatal("expected Allow() == false after re-trip to Open")
	}
}

func TestCircuitBreakerSlowCallCounting(t *testing.T) {
	fakeClk := clock.NewFakeClock(time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC))
	cfg := BreakerConfig{
		ConsecutiveFailures: 2,
		SlowCallDuration:    500 * time.Millisecond,
		ResetTimeout:        5 * time.Second,
	}

	cb := NewCircuitBreaker("upstream-slow", cfg, fakeClk, nil)

	// First slow call (600ms >= 500ms) counts as failure
	cb.RecordSuccess(600 * time.Millisecond)
	if cb.State() != BreakerClosed {
		t.Fatalf("expected Closed after 1 slow call, got %s", cb.State())
	}

	// Second slow call counts as 2nd consecutive failure -> trips to Open!
	cb.RecordSuccess(750 * time.Millisecond)
	if cb.State() != BreakerOpen {
		t.Fatalf("expected Open after 2 consecutive slow calls, got %s", cb.State())
	}
}
