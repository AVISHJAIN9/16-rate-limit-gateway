package gateway

import (
	"context"
	"fmt"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/identity"
	"rlgw/internal/obs"
	"rlgw/internal/policy"
	"rlgw/internal/store"
	"rlgw/internal/store/memory"
)

func TestLimiterTwoPhasePeekPreventsDebitOnRejection(t *testing.T) {
	// Policy A: limit 10
	polA := policy.Policy{
		ID:        "pol-A",
		Tenant:    "acme",
		Scope:     policy.ScopeClient,
		Algorithm: policy.AlgorithmTokenBucket,
		Limit:     10,
		Burst:     10,
		Window:    time.Minute,
		Priority:  10,
		Enabled:   true,
		Match:     policy.MatchSpec{RoutePattern: "/**"},
	}

	// Policy B: limit 1 (strict)
	polB := policy.Policy{
		ID:        "pol-B",
		Tenant:    "acme",
		Scope:     policy.ScopeClient,
		Algorithm: policy.AlgorithmTokenBucket,
		Limit:     1,
		Burst:     1,
		Window:    time.Minute,
		Priority:  20,
		Enabled:   true,
		Match:     policy.MatchSpec{RoutePattern: "/**"},
	}

	fakeClk := clock.NewFakeClock(time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC))
	snap, err := policy.CompileSnapshot("prod", 1, []policy.Policy{polA, polB}, nil, fakeClk)
	if err != nil {
		t.Fatalf("failed to compile snapshot: %v", err)
	}

	memStore := memory.NewMemoryStore(10_000)
	opts := LimiterOptions{
		Store:            memStore,
		SnapshotProvider: func() *policy.PolicySnapshot { return snap },
		Clock:            fakeClk,
	}
	limiter := NewRateLimiter(opts)

	id := &identity.Identity{
		Tenant:   "acme",
		ClientID: "client-1",
	}

	req := httptest.NewRequest("GET", "/api/data", nil)

	// First request: both A and B allow (consumes 1 on A, 1 on B)
	allowed1, outcome1, _, err := limiter.Intercept(context.Background(), req, id)
	if err != nil || !allowed1 {
		t.Fatalf("expected request 1 allowed, got allowed=%v, err=%v", allowed1, err)
	}
	if outcome1.PolicyID != "pol-B" {
		t.Errorf("expected most constraining policy to be pol-B, got %s", outcome1.PolicyID)
	}

	// Inspect store: Policy A has 9 remaining, Policy B has 0 remaining
	routeReq := policy.RouteRequest{Method: "GET", Path: "/api/data"}
	res, _ := snap.Resolve(routeReq, id.ToRequestIdentity())
	specA := store.AlgoSpec{Algorithm: string(polA.Algorithm), Limit: polA.Limit, Window: polA.Window, Burst: polA.Burst}
	specB := store.AlgoSpec{Algorithm: string(polB.Algorithm), Limit: polB.Limit, Window: polB.Window, Burst: polB.Burst}

	var keyA, keyB []byte
	for _, r := range res {
		if r.Policy.ID == "pol-A" {
			keyA = r.BinaryKey
		} else if r.Policy.ID == "pol-B" {
			keyB = r.BinaryKey
		}
	}

	decA1, _ := memStore.Peek(context.Background(), keyA, specA, fakeClk.Now())
	decB1, _ := memStore.Peek(context.Background(), keyB, specB, fakeClk.Now())
	if decA1.Remaining != 9 {
		t.Errorf("expected Policy A remaining 9, got %d", decA1.Remaining)
	}
	if decB1.Remaining != 0 {
		t.Errorf("expected Policy B remaining 0, got %d", decB1.Remaining)
	}

	// Second request: Policy A has capacity (9), but Policy B is exhausted (0)
	// Due to Two-Phase Decide (Peek all), Policy A's counter MUST NOT BE DEBITED!
	allowed2, outcome2, _, err := limiter.Intercept(context.Background(), req, id)
	if err != nil || allowed2 {
		t.Fatalf("expected request 2 rejected, got allowed=%v", allowed2)
	}
	if outcome2.PolicyID != "pol-B" {
		t.Errorf("expected rejection by pol-B, got %s", outcome2.PolicyID)
	}

	// Verify that Policy A's remaining counter is STILL 9 (was not decremented)!
	decA2, _ := memStore.Peek(context.Background(), keyA, specA, fakeClk.Now())
	if decA2.Remaining != 9 {
		t.Fatalf("CRITICAL: Counter leak! Policy A was debited to %d despite request rejection by Policy B!", decA2.Remaining)
	}
}

func TestLimiterRetryAfterClockWaitCorrectness(t *testing.T) {
	fakeClk := clock.NewFakeClock(time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC))

	pol := policy.Policy{
		ID:        "pol-burst",
		Tenant:    "acme",
		Scope:     policy.ScopeClient,
		Algorithm: policy.AlgorithmTokenBucket,
		Limit:     1,
		Burst:     1,
		Window:    10 * time.Second, // 1 token every 10s
		Priority:  1,
		Enabled:   true,
		Match:     policy.MatchSpec{RoutePattern: "/**"},
	}

	snap, _ := policy.CompileSnapshot("prod", 1, []policy.Policy{pol}, nil, fakeClk)
	memStore := memory.NewMemoryStore(1000)
	limiter := NewRateLimiter(LimiterOptions{
		Store:            memStore,
		SnapshotProvider: func() *policy.PolicySnapshot { return snap },
		Clock:            fakeClk,
	})

	id := &identity.Identity{Tenant: "acme", ClientID: "c1"}
	req := httptest.NewRequest("GET", "/test", nil)

	// Req 1: allowed
	allowed, _, _, _ := limiter.Intercept(context.Background(), req, id)
	if !allowed {
		t.Fatal("request 1 should be allowed")
	}

	// Req 2: denied with RetryAfter
	allowed, outcome, _, _ := limiter.Intercept(context.Background(), req, id)
	if allowed {
		t.Fatal("request 2 should be denied")
	}
	if outcome.RetryAfter <= 0 {
		t.Fatalf("expected positive RetryAfter, got %v", outcome.RetryAfter)
	}

	// Wait 1 millisecond less than RetryAfter: still denied
	fakeClk.Advance(outcome.RetryAfter - time.Millisecond)
	allowed, _, _, _ = limiter.Intercept(context.Background(), req, id)
	if allowed {
		t.Fatal("should still be denied before RetryAfter fully elapses")
	}

	// Advance clock by remaining duration: now succeeds!
	fakeClk.Advance(2 * time.Millisecond)
	allowed, _, _, _ = limiter.Intercept(context.Background(), req, id)
	if !allowed {
		t.Fatal("request should succeed immediately after RetryAfter elapses")
	}
}

// mockErrorStore simulates store failures for testing fail_open, fail_closed, degrade_local
type mockErrorStore struct {
	failDecide bool
	failPeek   bool
}

func (m *mockErrorStore) Decide(ctx context.Context, key []byte, spec store.AlgoSpec, cost int64, now time.Time) (store.Decision, error) {
	if m.failDecide {
		return store.Decision{}, fmt.Errorf("redis connection timeout")
	}
	return store.Decision{Allowed: true, Remaining: 100}, nil
}

func (m *mockErrorStore) Peek(ctx context.Context, key []byte, spec store.AlgoSpec, now time.Time) (store.Decision, error) {
	if m.failPeek {
		return store.Decision{}, fmt.Errorf("redis cluster down")
	}
	return store.Decision{Allowed: true, Remaining: 100}, nil
}

func (m *mockErrorStore) Refund(ctx context.Context, key []byte, spec store.AlgoSpec, amount int64, now time.Time) error {
	return nil
}

func TestLimiterFailModes(t *testing.T) {
	fakeClk := clock.NewFakeClock(time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC))
	rec := obs.NewPrometheusRegistry()

	// 1. Fail Open Mode
	polOpen := policy.Policy{
		ID:        "pol-open",
		Tenant:    "acme",
		Scope:     policy.ScopeClient,
		Algorithm: policy.AlgorithmTokenBucket,
		Limit:     10,
		Window:    time.Minute,
		Enabled:   true,
		FailMode:  "fail_open",
		Match:     policy.MatchSpec{RoutePattern: "/**"},
	}
	snapOpen, _ := policy.CompileSnapshot("prod", 1, []policy.Policy{polOpen}, nil, fakeClk)
	limiterOpen := NewRateLimiter(LimiterOptions{
		Store:            &mockErrorStore{failPeek: true},
		SnapshotProvider: func() *policy.PolicySnapshot { return snapOpen },
		Clock:            fakeClk,
		Recorder:         rec,
	})

	id := &identity.Identity{Tenant: "acme", ClientID: "c1"}
	req := httptest.NewRequest("GET", "/test", nil)

	allowed, _, _, err := limiterOpen.Intercept(context.Background(), req, id)
	if err != nil || !allowed {
		t.Fatalf("expected fail_open policy to allow request on store error, got allowed=%v, err=%v", allowed, err)
	}

	// 2. Fail Closed Mode
	polClosed := policy.Policy{
		ID:        "pol-closed",
		Tenant:    "acme",
		Scope:     policy.ScopeClient,
		Algorithm: policy.AlgorithmTokenBucket,
		Limit:     10,
		Window:    time.Minute,
		Enabled:   true,
		FailMode:  "fail_closed",
		Match:     policy.MatchSpec{RoutePattern: "/**"},
	}
	snapClosed, _ := policy.CompileSnapshot("prod", 1, []policy.Policy{polClosed}, nil, fakeClk)
	limiterClosed := NewRateLimiter(LimiterOptions{
		Store:            &mockErrorStore{failPeek: true},
		SnapshotProvider: func() *policy.PolicySnapshot { return snapClosed },
		Clock:            fakeClk,
		Recorder:         rec,
	})

	allowedClosed, _, _, _ := limiterClosed.Intercept(context.Background(), req, id)
	if allowedClosed {
		t.Fatal("expected fail_closed policy to reject request on store error")
	}

	// 3. Degrade Local Mode
	polDegrade := policy.Policy{
		ID:        "pol-degrade",
		Tenant:    "acme",
		Scope:     policy.ScopeClient,
		Algorithm: policy.AlgorithmTokenBucket,
		Limit:     2,
		Window:    time.Minute,
		Enabled:   true,
		FailMode:  "degrade_local",
		Match:     policy.MatchSpec{RoutePattern: "/**"},
	}
	snapDegrade, _ := policy.CompileSnapshot("prod", 1, []policy.Policy{polDegrade}, nil, fakeClk)
	limiterDegrade := NewRateLimiter(LimiterOptions{
		Store:            &mockErrorStore{failPeek: true},
		SnapshotProvider: func() *policy.PolicySnapshot { return snapDegrade },
		Clock:            fakeClk,
		Recorder:         rec,
	})

	// Local fallback has limit 2: first 2 allowed, 3rd denied
	all1, _, _, _ := limiterDegrade.Intercept(context.Background(), req, id)
	all2, _, _, _ := limiterDegrade.Intercept(context.Background(), req, id)
	all3, _, _, _ := limiterDegrade.Intercept(context.Background(), req, id)

	if !all1 || !all2 {
		t.Fatalf("expected first 2 calls to degrade_local to succeed, got %v, %v", all1, all2)
	}
	if all3 {
		t.Fatal("expected 3rd call to degrade_local to be rejected by local capacity limit")
	}
}

// mockRaceStore simulates a concurrent debit where Decide rejects despite Peek allowing
type mockRaceStore struct {
	decideCount atomic.Int64
	refundCount atomic.Int64
}

func (m *mockRaceStore) Decide(ctx context.Context, key []byte, spec store.AlgoSpec, cost int64, now time.Time) (store.Decision, error) {
	c := m.decideCount.Add(1)
	if c == 1 {
		// Policy 1 commits successfully
		return store.Decision{Allowed: true, Remaining: 5}, nil
	}
	// Policy 2 experiences a concurrent race: quota just exhausted!
	return store.Decision{Allowed: false, Remaining: 0, RetryAfter: 5 * time.Second}, nil
}

func (m *mockRaceStore) Peek(ctx context.Context, key []byte, spec store.AlgoSpec, now time.Time) (store.Decision, error) {
	// Both peek allowed in phase 1
	return store.Decision{Allowed: true, Remaining: 10}, nil
}

func (m *mockRaceStore) Refund(ctx context.Context, key []byte, spec store.AlgoSpec, amount int64, now time.Time) error {
	m.refundCount.Add(1)
	return nil
}

func TestLimiterRaceConditionRollbackRefund(t *testing.T) {
	fakeClk := clock.NewFakeClock(time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC))

	pol1 := policy.Policy{ID: "p1", Tenant: "acme", Scope: policy.ScopeClient, Algorithm: policy.AlgorithmTokenBucket, Limit: 10, Window: time.Minute, Priority: 1, Enabled: true, Match: policy.MatchSpec{RoutePattern: "/**"}}
	pol2 := policy.Policy{ID: "p2", Tenant: "acme", Scope: policy.ScopeClient, Algorithm: policy.AlgorithmTokenBucket, Limit: 10, Window: time.Minute, Priority: 2, Enabled: true, Match: policy.MatchSpec{RoutePattern: "/**"}}

	snap, _ := policy.CompileSnapshot("prod", 1, []policy.Policy{pol1, pol2}, nil, fakeClk)
	raceStore := &mockRaceStore{}

	limiter := NewRateLimiter(LimiterOptions{
		Store:            raceStore,
		SnapshotProvider: func() *policy.PolicySnapshot { return snap },
		Clock:            fakeClk,
	})

	id := &identity.Identity{Tenant: "acme", ClientID: "c1"}
	req := httptest.NewRequest("GET", "/test", nil)

	allowed, _, _, _ := limiter.Intercept(context.Background(), req, id)
	if allowed {
		t.Fatal("expected request to be rejected due to Policy 2 race exhaustion")
	}

	// Crucial check: Policy 1 was committed, so when Policy 2 failed, Refund MUST have been called!
	if raceStore.refundCount.Load() != 1 {
		t.Fatalf("CRITICAL: Expected 1 refund call on race rollback, got %d", raceStore.refundCount.Load())
	}
}
