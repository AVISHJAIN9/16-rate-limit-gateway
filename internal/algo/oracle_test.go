package algo

import (
	"math/rand"
	"testing"
	"time"
)

func TestOraclePropertyEquivalence100kSchedules(t *testing.T) {
	seed := int64(42) // Fixed seed for reproducible property tests
	rng := rand.New(rand.NewSource(seed))

	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("Property test failed under seed: %d", seed)
		}
	})

	const iterations = 100_000

	p := Params{
		Limit:         50,
		Burst:         50,
		Window:        time.Second,
		AllowZeroCost: false,
	}

	oracleTB := NewNaiveOracle(p)
	var stTB TokenBucketState

	oracleFW := NewNaiveOracle(p)
	var stFW FixedWindowState

	oracleSL := NewNaiveOracle(p)
	stSL := NewSlidingWindowLogState(1024)

	oracleGCRA := NewNaiveOracle(p)
	var stGCRA GCRAState

	var stSWC SlidingWindowCounterState

	var currentNs int64 = 1_000_000_000 // 1s baseline

	// Test 100,000 steps with randomized jitter, bursts, and weighted costs
	for i := 0; i < iterations; i++ {
		// Advance monotonic time by 0 to 50ms with jitter
		jitterNs := int64(rng.Intn(50_000_000))
		currentNs += jitterNs

		// Weighted cost: 1 to 5 (occasionally 0 or over-burst to test guards)
		var cost int64
		roll := rng.Intn(100)
		if roll < 5 {
			cost = 0 // test zero cost
		} else if roll < 95 {
			cost = int64(1 + rng.Intn(4)) // 1 to 4 cost
		} else {
			cost = 60 // over burst
		}

		// 1. Token Bucket vs Oracle
		oracleAllowedTB := oracleTB.DecideTokenBucket(currentNs, cost)
		var decTB Decision
		stTB, decTB = TokenBucketStep(stTB, p, cost, currentNs)
		if decTB.Allowed != oracleAllowedTB {
			t.Fatalf("step %d: TokenBucket mismatch! Kernel=%v, Oracle=%v (cost=%d, dt=%d)",
				i, decTB.Allowed, oracleAllowedTB, cost, jitterNs)
		}
		oracleTB.Record(currentNs, cost, decTB.Allowed)

		// 2. Fixed Window vs Oracle
		oracleAllowedFW := oracleFW.DecideFixedWindow(currentNs, cost)
		var decFW Decision
		stFW, decFW = FixedWindowStep(stFW, p, cost, currentNs)
		if decFW.Allowed != oracleAllowedFW {
			t.Fatalf("step %d: FixedWindow mismatch! Kernel=%v, Oracle=%v (cost=%d)",
				i, decFW.Allowed, oracleAllowedFW, cost)
		}
		oracleFW.Record(currentNs, cost, decFW.Allowed)

		// 3. Sliding Window Log vs Oracle
		oracleAllowedSL := oracleSL.DecideSlidingWindowLog(currentNs, cost)
		var decSL Decision
		stSL, decSL = SlidingWindowLogStep(stSL, p, cost, currentNs)
		if decSL.Allowed != oracleAllowedSL {
			t.Fatalf("step %d: SlidingWindowLog mismatch! Kernel=%v, Oracle=%v (cost=%d)",
				i, decSL.Allowed, oracleAllowedSL, cost)
		}
		oracleSL.Record(currentNs, cost, decSL.Allowed)

		// 4. GCRA vs Oracle
		oracleAllowedGCRA := oracleGCRA.DecideGCRA(currentNs, cost)
		var decGCRA Decision
		stGCRA, decGCRA = GCRAStep(stGCRA, p, cost, currentNs)
		if decGCRA.Allowed != oracleAllowedGCRA {
			t.Fatalf("step %d: GCRA mismatch! Kernel=%v, Oracle=%v (cost=%d)",
				i, decGCRA.Allowed, oracleAllowedGCRA, cost)
		}
		oracleGCRA.Record(currentNs, cost, decGCRA.Allowed)

		// 5. Sliding Window Counter bounded approximation invariant
		var decSWC Decision
		stSWC, decSWC = SlidingWindowCounterStep(stSWC, p, cost, currentNs)
		if decSWC.Allowed {
			// Conservation law: current count in window must not exceed 2x limit
			if stSWC.CurrCount > p.Limit {
				t.Fatalf("step %d: SWC exceeded capacity in window: %d > %d", i, stSWC.CurrCount, p.Limit)
			}
		}
	}
}

// Microbenchmarks for all pure kernels (target: ≤ 150 ns p50 and 0 allocs/op)

func BenchmarkTokenBucketKernel(b *testing.B) {
	p := Params{Limit: 1000, Burst: 1000, Window: time.Second}
	var st TokenBucketState
	now := int64(1_000_000_000)

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		st, _ = TokenBucketStep(st, p, 1, now+int64(i*1000))
	}
}

func BenchmarkLeakyBucketKernel(b *testing.B) {
	p := Params{Limit: 1000, Burst: 1000, Window: time.Second}
	var st LeakyBucketState
	now := int64(1_000_000_000)

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		st, _ = LeakyBucketStep(st, p, 1, now+int64(i*1000))
	}
}

func BenchmarkFixedWindowKernel(b *testing.B) {
	p := Params{Limit: 1000, Burst: 1000, Window: time.Second}
	var st FixedWindowState
	now := int64(1_000_000_000)

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		st, _ = FixedWindowStep(st, p, 1, now+int64(i*1000))
	}
}

func BenchmarkSlidingWindowCounterKernel(b *testing.B) {
	p := Params{Limit: 1000, Burst: 1000, Window: time.Second}
	var st SlidingWindowCounterState
	now := int64(1_000_000_000)

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		st, _ = SlidingWindowCounterStep(st, p, 1, now+int64(i*1000))
	}
}

func BenchmarkGCRAKernel(b *testing.B) {
	p := Params{Limit: 1000, Burst: 1000, Window: time.Second}
	var st GCRAState
	now := int64(1_000_000_000)

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		st, _ = GCRAStep(st, p, 1, now+int64(i*1000))
	}
}

func BenchmarkSlidingWindowLogKernel(b *testing.B) {
	p := Params{Limit: 100, Burst: 100, Window: time.Second}
	st := NewSlidingWindowLogState(128)
	now := int64(1_000_000_000)

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		st, _ = SlidingWindowLogStep(st, p, 1, now+int64(i*10_000_000))
	}
}
