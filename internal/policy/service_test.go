package policy

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/errors"
)

func TestPolicyCRUDAndOptimisticConcurrency(t *testing.T) {
	ctx := context.Background()
	store := NewMemPolicyStore()
	clk := clock.NewFakeClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	svc := NewPolicyService(store, AllowAllAuthorizer{}, clk, ServiceConfig{})

	sub := AuthSubject{ID: "admin-1", Tenant: "acme", IsSuperAdmin: true}

	p := Policy{
		ID:        "pol-checkout",
		Name:      "Checkout API Rate Limit",
		Tenant:    "acme",
		Algorithm: AlgorithmTokenBucket,
		Scope:     ScopeClient,
		Limit:     100,
		Burst:     150,
		Window:    time.Minute,
		Enabled:   true,
	}

	// 1. Create
	rec, err := svc.CreatePolicy(ctx, sub, p, "alice", "initial creation")
	if err != nil {
		t.Fatalf("CreatePolicy failed: %v", err)
	}
	if rec.Revision != 1 {
		t.Fatalf("expected revision 1, got %d", rec.Revision)
	}
	if rec.ActiveVersion != 1 {
		t.Fatalf("expected active version 1, got %d", rec.ActiveVersion)
	}

	// 2. Get
	fetched, err := svc.GetPolicy(ctx, sub, "acme", "pol-checkout")
	if err != nil {
		t.Fatalf("GetPolicy failed: %v", err)
	}
	if fetched.Policy.Limit != 100 {
		t.Fatalf("expected limit 100, got %d", fetched.Policy.Limit)
	}

	// 3. Update with wrong revision -> conflict
	pUpdate := fetched.Policy
	pUpdate.Limit = 200
	pUpdate.Burst = 250
	_, err = svc.UpdatePolicy(ctx, sub, pUpdate, 999, "alice", "should fail")
	if err == nil || !errors.IsCode(err, errors.ErrCodeConflict) {
		t.Fatalf("expected ErrCodeConflict on wrong revision, got: %v", err)
	}

	// 4. Update with correct revision
	updated, err := svc.UpdatePolicy(ctx, sub, pUpdate, fetched.Revision, "bob", "increase limit")
	if err != nil {
		t.Fatalf("UpdatePolicy failed: %v", err)
	}
	if updated.Policy.Limit != 200 {
		t.Fatalf("expected limit 200, got %d", updated.Policy.Limit)
	}
	if updated.Policy.Version != 2 {
		t.Fatalf("expected version 2, got %d", updated.Policy.Version)
	}

	// 5. List with filtering
	listRes, err := svc.ListPolicies(ctx, sub, ListFilter{Tenant: "acme", Algorithm: AlgorithmTokenBucket}, Pagination{Page: 1, Limit: 10})
	if err != nil {
		t.Fatalf("ListPolicies failed: %v", err)
	}
	if listRes.Total != 1 || len(listRes.Policies) != 1 {
		t.Fatalf("expected 1 policy in list, got %d", listRes.Total)
	}

	// 6. Delete with wrong revision -> conflict
	err = svc.DeletePolicy(ctx, sub, "acme", "pol-checkout", 1)
	if err == nil || !errors.IsCode(err, errors.ErrCodeConflict) {
		t.Fatalf("expected conflict on delete with stale revision, got: %v", err)
	}

	// Delete with correct revision
	err = svc.DeletePolicy(ctx, sub, "acme", "pol-checkout", updated.Revision)
	if err != nil {
		t.Fatalf("DeletePolicy failed: %v", err)
	}

	// Should be not found now
	_, err = svc.GetPolicy(ctx, sub, "acme", "pol-checkout")
	if err == nil || !errors.IsCode(err, errors.ErrCodeNotFound) {
		t.Fatalf("expected ErrCodeNotFound after delete, got %v", err)
	}
}

func TestConcurrentOptimisticLocking(t *testing.T) {
	ctx := context.Background()
	store := NewMemPolicyStore()
	clk := clock.NewRealClock()
	svc := NewPolicyService(store, AllowAllAuthorizer{}, clk, ServiceConfig{})
	sub := AuthSubject{ID: "admin-1", Tenant: "acme", IsSuperAdmin: true}

	p := Policy{
		ID:        "pol-concurrent",
		Name:      "Concurrent Policy",
		Tenant:    "acme",
		Algorithm: AlgorithmFixedWindow,
		Scope:     ScopeIP,
		Limit:     50,
		Burst:     50,
		Window:    time.Second,
		Enabled:   true,
	}

	rec, err := svc.CreatePolicy(ctx, sub, p, "author", "init")
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}

	const goroutines = 20
	var wg sync.WaitGroup
	wg.Add(goroutines)

	successCount := 0
	conflictCount := 0
	var mu sync.Mutex

	for i := 0; i < goroutines; i++ {
		go func(idx int) {
			defer wg.Done()
			pCopy := rec.Policy
			pCopy.Limit = int64(100 + idx)
			_, err := svc.UpdatePolicy(ctx, sub, pCopy, rec.Revision, fmt.Sprintf("worker-%d", idx), "update")

			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				successCount++
			} else if errors.IsCode(err, errors.ErrCodeConflict) {
				conflictCount++
			}
		}(i)
	}

	wg.Wait()

	if successCount != 1 {
		t.Fatalf("expected exactly 1 concurrent update to succeed, got %d", successCount)
	}
	if conflictCount != goroutines-1 {
		t.Fatalf("expected %d conflicts, got %d", goroutines-1, conflictCount)
	}
}

func TestPolicyVersioningRollbackAndDiff(t *testing.T) {
	ctx := context.Background()
	store := NewMemPolicyStore()
	clk := clock.NewFakeClock(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	svc := NewPolicyService(store, AllowAllAuthorizer{}, clk, ServiceConfig{MaxVersionsPerPolicy: 5})
	sub := AuthSubject{ID: "admin", Tenant: "acme"}

	p := Policy{
		ID:        "pol-v",
		Name:      "Versioned Policy",
		Tenant:    "acme",
		Algorithm: AlgorithmTokenBucket,
		Scope:     ScopeUser,
		Limit:     100,
		Burst:     150,
		Window:    time.Minute,
		Enabled:   true,
	}

	// Version 1
	rec1, err := svc.CreatePolicy(ctx, sub, p, "alice", "v1")
	if err != nil {
		t.Fatalf("v1 create failed: %v", err)
	}

	// Version 2
	p2 := rec1.Policy
	p2.Limit = 200
	p2.Burst = 250
	rec2, err := svc.UpdatePolicy(ctx, sub, p2, rec1.Revision, "bob", "v2")
	if err != nil {
		t.Fatalf("v2 update failed: %v", err)
	}

	// Version 3
	p3 := rec2.Policy
	p3.Limit = 300
	p3.Burst = 350
	_, err = svc.UpdatePolicy(ctx, sub, p3, rec2.Revision, "charlie", "v3")
	if err != nil {
		t.Fatalf("v3 update failed: %v", err)
	}

	// Diff v1 vs v3
	diff, err := svc.DiffVersions(ctx, sub, "acme", "pol-v", 1, 3)
	if err != nil {
		t.Fatalf("diff failed: %v", err)
	}
	if len(diff.Fields) == 0 {
		t.Fatalf("expected field differences between v1 and v3")
	}

	// Rollback to v1 -> should create version 4 with v1's limits
	rec4, err := svc.RollbackPolicy(ctx, sub, "acme", "pol-v", 1, "dave", "rollback to v1")
	if err != nil {
		t.Fatalf("rollback failed: %v", err)
	}
	if rec4.Policy.Version != 4 {
		t.Fatalf("expected rollback version to be monotonic v4, got %d", rec4.Policy.Version)
	}
	if rec4.Policy.Limit != 100 || rec4.Policy.Burst != 150 {
		t.Fatalf("expected rolled back limits (100/150), got %d/%d", rec4.Policy.Limit, rec4.Policy.Burst)
	}

	// Scheduled activation
	future := clk.Now().Add(10 * time.Minute)
	err = svc.ActivateVersion(ctx, sub, "acme", "pol-v", 2, future)
	if err != nil {
		t.Fatalf("activate version failed: %v", err)
	}
	activeRec, _ := svc.GetPolicy(ctx, sub, "acme", "pol-v")
	if activeRec.ActiveVersion != 2 {
		t.Fatalf("expected active version 2, got %d", activeRec.ActiveVersion)
	}
	if !activeRec.ActiveAt.Equal(future) {
		t.Fatalf("expected activeAt to be scheduled at %v, got %v", future, activeRec.ActiveAt)
	}
}
