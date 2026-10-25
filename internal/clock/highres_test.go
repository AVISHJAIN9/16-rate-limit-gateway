package clock

import (
	"testing"
	"time"
)

func TestSkewGuardBackwardAndForwardJumps(t *testing.T) {
	guard := NewSkewGuard(50 * time.Millisecond)

	var lastSeen int64 = 1_000_000_000 // 1s

	// 1. Forward progression: no clamp
	eff1, clamped1 := guard.GuardMonotonic(lastSeen, 1_000_005_000)
	if clamped1 || eff1 != 1_000_005_000 {
		t.Fatalf("unexpected clamp on forward progression: %d, %v", eff1, clamped1)
	}

	// 2. Backward leap of 200ms: must clamp to lastSeen
	eff2, clamped2 := guard.GuardMonotonic(1_000_005_000, 1_000_005_000-200_000_000)
	if !clamped2 || eff2 != 1_000_005_000 {
		t.Fatalf("backward jump must be clamped to lastSeen, got eff=%d, clamped=%v", eff2, clamped2)
	}

	if guard.ClampedEvents.Load() != 1 {
		t.Fatalf("expected 1 clamped event recorded, got %d", guard.ClampedEvents.Load())
	}
}

func BenchmarkHighResClockNow(b *testing.B) {
	h := NewHighResClock()
	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		_ = h.NowNs()
	}
}

func BenchmarkTimeNowBaseline(b *testing.B) {
	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		_ = time.Now().UnixNano()
	}
}
