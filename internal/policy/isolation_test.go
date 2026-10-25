package policy

import (
	"context"
	"testing"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/errors"
)

func TestCrossTenantIsolationMatrix(t *testing.T) {
	ctx := context.Background()
	store := NewMemPolicyStore()
	clk := clock.NewRealClock()
	svc := NewPolicyService(store, AllowAllAuthorizer{}, clk, ServiceConfig{})

	subA := AuthSubject{ID: "admin-a", Tenant: "tenant-a"}
	subB := AuthSubject{ID: "admin-b", Tenant: "tenant-b"}

	// 1. Tenant A creates a policy
	polA := Policy{
		ID:        "pol-secret-a",
		Name:      "Confidential A Policy",
		Tenant:    "tenant-a",
		Algorithm: AlgorithmTokenBucket,
		Scope:     ScopeClient,
		Limit:     100,
		Burst:     100,
		Window:    time.Minute,
		Enabled:   true,
	}
	recA, err := svc.CreatePolicy(ctx, subA, polA, "alice", "init A")
	if err != nil {
		t.Fatalf("Tenant A create policy failed: %v", err)
	}

	// 2. Tenant B attempts GetPolicy on Tenant A's policy
	_, err = svc.GetPolicy(ctx, subB, "tenant-b", "pol-secret-a")
	if err == nil || !errors.IsCode(err, errors.ErrCodeNotFound) {
		t.Fatalf("PENETRATION LEAK: Tenant B retrieved Tenant A's policy! got: %v", err)
	}

	// 3. Tenant B lists policies -> must not see Tenant A's policy
	listB, err := svc.ListPolicies(ctx, subB, ListFilter{Tenant: "tenant-b"}, Pagination{Limit: 100})
	if err != nil {
		t.Fatalf("Tenant B list failed: %v", err)
	}
	for _, p := range listB.Policies {
		if p.Policy.ID == "pol-secret-a" || p.Policy.Tenant == "tenant-a" {
			t.Fatalf("PENETRATION LEAK: Tenant B list leaked Tenant A's policy: %+v", p)
		}
	}

	// 4. Tenant B attempts UpdatePolicy on Tenant A's policy
	hackUpdate := recA.Policy
	hackUpdate.Tenant = "tenant-b"
	hackUpdate.Limit = 999999
	_, err = svc.UpdatePolicy(ctx, subB, hackUpdate, recA.Revision, "mallory", "hack")
	if err == nil || !errors.IsCode(err, errors.ErrCodeNotFound) {
		t.Fatalf("PENETRATION LEAK: Tenant B updated Tenant A's policy! got: %v", err)
	}

	// 5. Tenant B attempts DeletePolicy on Tenant A's policy
	err = svc.DeletePolicy(ctx, subB, "tenant-b", "pol-secret-a", recA.Revision)
	if err == nil || !errors.IsCode(err, errors.ErrCodeNotFound) {
		t.Fatalf("PENETRATION LEAK: Tenant B deleted Tenant A's policy! got: %v", err)
	}

	// 6. Tenant B attempts GetVersion on Tenant A's policy
	_, err = svc.GetVersion(ctx, subB, "tenant-b", "pol-secret-a", 1)
	if err == nil || !errors.IsCode(err, errors.ErrCodeNotFound) {
		t.Fatalf("PENETRATION LEAK: Tenant B accessed Tenant A's version history! got: %v", err)
	}

	// 7. Tenant B attempts ActivateVersion on Tenant A's policy
	err = svc.ActivateVersion(ctx, subB, "tenant-b", "pol-secret-a", 1, time.Time{})
	if err == nil || !errors.IsCode(err, errors.ErrCodeNotFound) {
		t.Fatalf("PENETRATION LEAK: Tenant B activated Tenant A's policy version! got: %v", err)
	}

	// 8. Tenant B attempts RollbackPolicy on Tenant A's policy
	_, err = svc.RollbackPolicy(ctx, subB, "tenant-b", "pol-secret-a", 1, "mallory", "rollback attempt")
	if err == nil || !errors.IsCode(err, errors.ErrCodeNotFound) {
		t.Fatalf("PENETRATION LEAK: Tenant B rolled back Tenant A's policy! got: %v", err)
	}

	// 9. Tenant A creates an override
	newLimit := int64(120)
	ovA := OverrideRecord{
		ID:        "ov-a-1",
		Tenant:    "tenant-a",
		PolicyID:  "pol-secret-a",
		Limit:     &newLimit,
		ExpiresAt: clk.Now().Add(time.Hour),
	}
	if err := svc.CreateOverride(ctx, subA, ovA); err != nil {
		t.Fatalf("Tenant A create override failed: %v", err)
	}

	// Tenant B attempts to get Tenant A's override
	_, err = svc.ListOverrides(ctx, subB, "tenant-b")
	if err != nil {
		t.Fatalf("Tenant B list overrides failed: %v", err)
	}
	err = svc.RevokeOverride(ctx, subB, "tenant-b", "ov-a-1")
	if err == nil || !errors.IsCode(err, errors.ErrCodeNotFound) {
		t.Fatalf("PENETRATION LEAK: Tenant B revoked Tenant A's override! got: %v", err)
	}

	// 10. Tenant A creates a template
	tmplA := TemplateRecord{
		ID:      "tmpl-secret-a",
		Tenant:  "tenant-a",
		Name:    "Blueprint A",
		Version: 1,
		Body:    `{"id":"p1","tenant":"tenant-a","algorithm":"token_bucket","limit":10,"burst":10,"window":"1s","scope":"client"}`,
	}
	if err := svc.CreateTemplate(ctx, subA, tmplA); err != nil {
		t.Fatalf("Tenant A create template failed: %v", err)
	}

	// Tenant B attempts to get or delete Tenant A's template
	_, err = svc.GetTemplate(ctx, subB, "tenant-b", "tmpl-secret-a")
	if err == nil || !errors.IsCode(err, errors.ErrCodeNotFound) {
		t.Fatalf("PENETRATION LEAK: Tenant B retrieved Tenant A's template! got: %v", err)
	}

	// 11. Snapshot.Resolve cross-tenant isolation:
	// A compiled snapshot with Tenant A's policies must never match requests for Tenant B
	snap, err := CompileSnapshot("prod", 1, []Policy{recA.Policy}, nil, clk)
	if err != nil {
		t.Fatalf("CompileSnapshot failed: %v", err)
	}

	resolvedB, err := snap.Resolve(RouteRequest{Method: "GET", Path: "/api/v1/anything"}, RequestIdentity{
		Tenant:   "tenant-b",
		ClientID: "client-b",
	})
	if err != nil {
		t.Fatalf("Resolve failed: %v", err)
	}
	for _, r := range resolvedB {
		if r.Policy.Tenant == "tenant-a" {
			t.Fatalf("PENETRATION LEAK: Snapshot.Resolve matched Tenant A's policy for Tenant B request!")
		}
	}
}
