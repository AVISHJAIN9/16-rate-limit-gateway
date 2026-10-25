package clock

import (
	"sync"
	"testing"
	"time"
)

func TestRealClock(t *testing.T) {
	rc := NewRealClock()
	t1 := rc.Now()
	if t1.IsZero() {
		t.Fatal("expected non-zero real clock time")
	}
	d := rc.Since(t1)
	if d < 0 {
		t.Fatalf("expected non-negative duration, got %v", d)
	}
}

func TestFakeClockDeterministic(t *testing.T) {
	base := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	fc := NewFakeClock(base)

	if !fc.Now().Equal(base) {
		t.Fatalf("expected %v, got %v", base, fc.Now())
	}

	fc.Advance(500 * time.Millisecond)
	expected := base.Add(500 * time.Millisecond)
	if !fc.Now().Equal(expected) {
		t.Fatalf("expected %v, got %v", expected, fc.Now())
	}

	since := fc.Since(base)
	if since != 500*time.Millisecond {
		t.Fatalf("expected 500ms since base, got %v", since)
	}

	newTime := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	fc.Set(newTime)
	if !fc.Now().Equal(newTime) {
		t.Fatalf("expected %v, got %v", newTime, fc.Now())
	}
}

func TestFakeClockConcurrency(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	fc := NewFakeClock(base)

	var wg sync.WaitGroup
	const goroutines = 20
	const iterations = 500

	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				fc.Advance(time.Millisecond)
				_ = fc.Now()
				_ = fc.Since(base)
			}
		}()
	}

	wg.Wait()
	expectedDelta := time.Duration(goroutines*iterations) * time.Millisecond
	actualDelta := fc.Since(base)
	if actualDelta != expectedDelta {
		t.Fatalf("expected delta %v, got %v", expectedDelta, actualDelta)
	}
}
