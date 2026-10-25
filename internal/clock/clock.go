package clock

import (
	"sync"
	"time"
)

// Clock defines the injectable monotonic time provider.
// All rate limiting, refill arithmetic, and token decay decisions MUST
// query time via Clock, never directly invoking time.Now().
type Clock interface {
	Now() time.Time
	Since(t time.Time) time.Duration
}

// RealClock provides monotonic time backed by the OS wall clock.
type RealClock struct{}

// NewRealClock returns an initialized RealClock.
func NewRealClock() *RealClock {
	return &RealClock{}
}

// Now returns the current monotonic time.
func (r *RealClock) Now() time.Time {
	return time.Now()
}

// Since returns the elapsed duration since t.
func (r *RealClock) Since(t time.Time) time.Duration {
	return time.Since(t)
}

// FakeClock provides a thread-safe deterministic simulated clock for testing.
// It never sleeps and advances strictly under caller control.
type FakeClock struct {
	mu  sync.RWMutex
	now time.Time
}

// NewFakeClock creates a FakeClock pinned to initialTime.
func NewFakeClock(initialTime time.Time) *FakeClock {
	return &FakeClock{
		now: initialTime,
	}
}

// Now returns the simulated current time.
func (f *FakeClock) Now() time.Time {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.now
}

// Since returns the simulated elapsed duration since t.
func (f *FakeClock) Since(t time.Time) time.Duration {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.now.Sub(t)
}

// Set explicitly sets the simulated time to t.
func (f *FakeClock) Set(t time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = t
}

// Advance increments the simulated clock forward by d.
func (f *FakeClock) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d)
}

// Add is an alias for Advance for ergonomic time additions.
func (f *FakeClock) Add(d time.Duration) {
	f.Advance(d)
}
