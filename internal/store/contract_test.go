package store_test

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"rlgw/internal/store"
	"rlgw/internal/store/memory"
)

// RunStoreContractTestSuite runs the complete normative compliance suite against any Store implementation (F28).
func RunStoreContractTestSuite(t *testing.T, newStore func() store.Store) {
	t.Run("BasicFixedWindowDecision", func(t *testing.T) {
		s := newStore()
		ctx := context.Background()
		now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		key := []byte("contract:test:fw:1")
		spec := store.AlgoSpec{
			Algorithm: "fixed_window",
			Limit:     2,
			Window:    time.Second,
			Burst:     2,
		}

		// First request allowed
		d1, err := s.Decide(ctx, key, spec, 1, now)
		if err != nil || !d1.Allowed || d1.Remaining != 1 {
			t.Fatalf("first request failed: %+v, err: %v", d1, err)
		}

		// Second request allowed
		d2, err := s.Decide(ctx, key, spec, 1, now)
		if err != nil || !d2.Allowed || d2.Remaining != 0 {
			t.Fatalf("second request failed: %+v, err: %v", d2, err)
		}

		// Third request denied
		d3, err := s.Decide(ctx, key, spec, 1, now)
		if err != nil || d3.Allowed {
			t.Fatalf("third request must be denied: %+v", d3)
		}
	})

	t.Run("TokenBucketContinuousRefill", func(t *testing.T) {
		s := newStore()
		ctx := context.Background()
		now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		key := []byte("contract:test:tb:1")
		spec := store.AlgoSpec{
			Algorithm: "token_bucket",
			Limit:     10,
			Window:    time.Second,
			Burst:     10,
		}

		// Consume all 10 tokens
		d, err := s.Decide(ctx, key, spec, 10, now)
		if err != nil || !d.Allowed || d.Remaining != 0 {
			t.Fatalf("initial burst consumption failed: %+v, err: %v", d, err)
		}

		// Immediately denied
		dDeny, err := s.Decide(ctx, key, spec, 1, now)
		if err != nil || dDeny.Allowed {
			t.Fatalf("immediate next request must be denied: %+v", dDeny)
		}

		// Advance 500ms -> refills 5 tokens
		later := now.Add(500 * time.Millisecond)
		dRefill, err := s.Decide(ctx, key, spec, 5, later)
		if err != nil || !dRefill.Allowed {
			t.Fatalf("refilled tokens were denied: %+v, err: %v", dRefill, err)
		}
	})

	t.Run("RefundQuotaRestoration", func(t *testing.T) {
		s := newStore()
		ctx := context.Background()
		now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		key := []byte("contract:test:refund:1")
		spec := store.AlgoSpec{
			Algorithm: "token_bucket",
			Limit:     5,
			Window:    time.Second,
			Burst:     5,
		}

		// Consume all 5
		_, _ = s.Decide(ctx, key, spec, 5, now)

		// Refund 2
		err := s.Refund(ctx, key, spec, 2, now)
		if err != nil {
			t.Fatalf("refund failed: %v", err)
		}

		// Should now allow 2 tokens
		d, err := s.Decide(ctx, key, spec, 2, now)
		if err != nil || !d.Allowed {
			t.Fatalf("expected refunded tokens to be available: %+v, err: %v", d, err)
		}
	})

	t.Run("PeekDoesNotMutateState", func(t *testing.T) {
		s := newStore()
		ctx := context.Background()
		now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		key := []byte("contract:test:peek:1")
		spec := store.AlgoSpec{
			Algorithm: "token_bucket",
			Limit:     10,
			Window:    time.Second,
			Burst:     10,
		}

		// Peek twice
		p1, err := s.Peek(ctx, key, spec, now)
		if err != nil || !p1.Allowed || p1.Remaining != 10 {
			t.Fatalf("peek 1 failed: %+v", p1)
		}

		p2, err := s.Peek(ctx, key, spec, now)
		if err != nil || !p2.Allowed || p2.Remaining != 10 {
			t.Fatalf("peek 2 failed: %+v", p2)
		}
	})

	t.Run("ConcurrentAdmissionsLinearizability", func(t *testing.T) {
		s := newStore()
		ctx := context.Background()
		now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		key := []byte("contract:test:conc:1")
		const capacity int64 = 100
		spec := store.AlgoSpec{
			Algorithm: "token_bucket",
			Limit:     capacity,
			Window:    time.Minute,
			Burst:     capacity,
		}

		const numGoroutines = 20
		const requestsPerGoroutine = 10

		var wg sync.WaitGroup
		var allowedCount sync.Map

		for g := 0; g < numGoroutines; g++ {
			wg.Add(1)
			go func(gid int) {
				defer wg.Done()
				for r := 0; r < requestsPerGoroutine; r++ {
					dec, err := s.Decide(ctx, key, spec, 1, now)
					if err == nil && dec.Allowed {
						allowedCount.Store(fmt.Sprintf("%d-%d", gid, r), true)
					}
				}
			}(g)
		}

		wg.Wait()

		totalAllowed := 0
		allowedCount.Range(func(_, _ any) bool {
			totalAllowed++
			return true
		})

		if int64(totalAllowed) != capacity {
			t.Fatalf("linearizability violation: exactly %d requests must be admitted, got %d", capacity, totalAllowed)
		}
	})
}

func TestShardedMemoryStoreContractCompliance(t *testing.T) {
	RunStoreContractTestSuite(t, func() store.Store {
		return memory.NewShardedMemoryStore(1000, nil)
	})
}
