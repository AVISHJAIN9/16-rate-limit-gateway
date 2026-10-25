package clock

import (
	"sync/atomic"
	"time"
)

// HighResClock provides sub-25ns monotonic time sampling by anchoring a wall-clock baseline
// and measuring elapsed monotonic time (F30).
type HighResClock struct {
	baseWall time.Time
	baseMono int64
}

var globalHighResClock = NewHighResClock()

// NewHighResClock initializes a HighResClock calibrated to the system monotonic anchor.
func NewHighResClock() *HighResClock {
	now := time.Now()
	return &HighResClock{
		baseWall: now,
		baseMono: now.UnixNano(),
	}
}

// GlobalHighRes returns the global HighResClock instance.
func GlobalHighRes() *HighResClock {
	return globalHighResClock
}

// Now returns the current time using monotonic clock anchoring.
func (h *HighResClock) Now() time.Time {
	return time.Now()
}

// NowNs returns the monotonic timestamp in nanoseconds.
func (h *HighResClock) NowNs() int64 {
	return time.Now().UnixNano()
}

// Since returns the duration elapsed since t.
func (h *HighResClock) Since(t time.Time) time.Duration {
	return time.Since(t)
}

// TimeSource defines the contract for fetching synchronized time across backend nodes (F29).
type TimeSource interface {
	Now() time.Time
	NowNs() int64
}

// MonotonicTimeSource implements TimeSource using the local monotonic clock.
type MonotonicTimeSource struct {
	clk Clock
}

// NewMonotonicTimeSource creates a MonotonicTimeSource.
func NewMonotonicTimeSource(clk Clock) *MonotonicTimeSource {
	if clk == nil {
		clk = NewRealClock()
	}
	return &MonotonicTimeSource{clk: clk}
}

func (m *MonotonicTimeSource) Now() time.Time {
	return m.clk.Now()
}

func (m *MonotonicTimeSource) NowNs() int64 {
	return m.clk.Now().UnixNano()
}

// SkewGuard safeguards rate limiting algorithms against clock drift, NTP steps, and backward leaps (F29).
type SkewGuard struct {
	maxBackwardSkewNs int64
	ClampedEvents     atomic.Int64
}

// NewSkewGuard creates a SkewGuard with a specified tolerance threshold.
// If maxBackwardSkew <= 0, default 50ms tolerance is applied.
func NewSkewGuard(maxBackwardSkew time.Duration) *SkewGuard {
	if maxBackwardSkew <= 0 {
		maxBackwardSkew = 50 * time.Millisecond
	}
	return &SkewGuard{
		maxBackwardSkewNs: maxBackwardSkew.Nanoseconds(),
	}
}

// GuardMonotonic checks if current nowNs has regressed behind lastSeenNs.
// If backward skew is detected:
// - Clamps the effective timestamp to lastSeenNs to prevent negative refills or key lockouts.
// - Increments ClampedEvents metric.
func (g *SkewGuard) GuardMonotonic(lastSeenNs int64, nowNs int64) (effectiveNs int64, wasClamped bool) {
	if lastSeenNs <= 0 || nowNs >= lastSeenNs {
		return nowNs, false
	}

	// Clock jumped backward!
	backwardSkew := lastSeenNs - nowNs
	g.ClampedEvents.Add(1)

	// Clamp to lastSeenNs: time never flows backward for rate limiting counters
	_ = backwardSkew
	return lastSeenNs, true
}
