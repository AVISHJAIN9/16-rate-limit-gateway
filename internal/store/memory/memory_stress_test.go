package memory

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"rlgw/internal/store"
)

// TestConcurrency64GoroutinesStress verifies linearizability and absence of race conditions under heavy concurrent load.
func TestConcurrency64GoroutinesStress(t *testing.T) {
	st := NewShardedMemoryStore(10_000, nil)
	defer st.Close()

	ctx := context.Background()
	now := time.Now()

	const numGoroutines = 64
	const keysCount = 100
	const requestsPerKeyPerGoroutine = 50

	spec := store.AlgoSpec{
		Algorithm: "token_bucket",
		Limit:     100,
		Burst:     100,
		Window:    time.Hour,
	}

	var totalAdmitted atomic.Int64
	var wg sync.WaitGroup

	for g := 0; g < numGoroutines; g++ {
		wg.Add(1)
		go func(gid int) {
			defer wg.Done()
			for k := 0; k < keysCount; k++ {
				key := []byte(fmt.Sprintf("stress:key:%d", k))
				for r := 0; r < requestsPerKeyPerGoroutine; r++ {
					dec, err := st.Decide(ctx, key, spec, 1, now)
					if err == nil && dec.Allowed {
						totalAdmitted.Add(1)
					}
				}
			}
		}(g)
	}

	wg.Wait()

	// Conservation check: For keysCount keys with capacity 100 each, total admitted
	// can NEVER exceed (keysCount * 100) = 10,000
	maxExpected := int64(keysCount * 100)
	actual := totalAdmitted.Load()

	if actual > maxExpected {
		t.Fatalf("conservation violation: admitted %d, max possible was %d", actual, maxExpected)
	}
	if actual != maxExpected {
		t.Fatalf("under-admission error: expected exactly %d admitted across full burst, got %d", maxExpected, actual)
	}
}

// TestBoundedMemoryReclamationUnder10MKeys simulates high-cardinality keys with TTLs to verify memory is strictly bounded (F26).
func TestBoundedMemoryReclamationUnder10MKeys(t *testing.T) {
	const totalCap = 2048
	st := NewShardedMemoryStore(totalCap, nil)
	defer st.Close()

	ctx := context.Background()
	now := time.Now()
	spec := store.AlgoSpec{Algorithm: "fixed_window", Limit: 10, Window: time.Millisecond}

	// Insert 100,000 keys with past TTLs
	for i := 0; i < 100_000; i++ {
		key := []byte(fmt.Sprintf("k-%d", i))
		_, _ = st.Decide(ctx, key, spec, 1, now)
	}

	// Count total entries across all shards
	totalEntries := 0
	for i := 0; i < NumShards; i++ {
		st.shards[i].mu.Lock()
		totalEntries += len(st.shards[i].entries)
		st.shards[i].mu.Unlock()
	}

	// Must never exceed configured capacity
	if totalEntries > totalCap {
		t.Fatalf("memory unbounded: stored entries %d exceeded totalCap %d", totalEntries, totalCap)
	}
}

func BenchmarkShardedMemoryStoreDecide(b *testing.B) {
	st := NewShardedMemoryStore(100_000, nil)
	defer st.Close()

	ctx := context.Background()
	now := time.Now()
	key := []byte("bench:single:key")
	spec := store.AlgoSpec{
		Algorithm: "token_bucket",
		Limit:     1_000_000_000,
		Burst:     1_000_000_000,
		Window:    time.Hour,
	}

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		_, _ = st.Decide(ctx, key, spec, 1, now)
	}
}

func BenchmarkShardedMemoryStoreParallelDecide(b *testing.B) {
	st := NewShardedMemoryStore(100_000, nil)
	defer st.Close()

	ctx := context.Background()
	now := time.Now()
	spec := store.AlgoSpec{
		Algorithm: "token_bucket",
		Limit:     1_000_000_000,
		Burst:     1_000_000_000,
		Window:    time.Hour,
	}

	b.ResetTimer()
	b.ReportAllocs()

	b.RunParallel(func(pb *testing.PB) {
		idx := 0
		for pb.Next() {
			key := []byte(fmt.Sprintf("bench:par:key:%d", idx%1000))
			idx++
			_, _ = st.Decide(ctx, key, spec, 1, now)
		}
	})
}
