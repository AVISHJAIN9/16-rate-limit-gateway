package policy

import (
	"testing"
	"time"

	"rlgw/internal/errors"
)

func TestPolicyInheritanceAndProvenance(t *testing.T) {
	nodes := make(map[string]*PolicyNode)

	// 1. Root: Global Policy
	nodes["global-base"] = &PolicyNode{
		ID:    "global-base",
		Layer: LayerGlobal,
		Policy: Policy{
			ID:        "global-base",
			Tenant:    "global",
			Algorithm: AlgorithmTokenBucket,
			Scope:     ScopeIP,
			Limit:     1000,
			Burst:     1000,
			Window:    time.Minute,
			Enabled:   true,
			CostSpec:  CostSpec{Mode: "static", StaticCost: 1},
			OnReject:  OnRejectSpec{Status: 429, RetryAfterMode: "seconds"},
			Labels:    map[string]string{"tier": "standard", "source": "global"},
		},
		Specified: map[string]bool{
			FieldAlgorithm: true,
			FieldScope:     true,
			FieldLimit:     true,
			FieldBurst:     true,
			FieldWindow:    true,
			FieldCostSpec:  true,
			FieldOnReject:  true,
			FieldEnabled:   true,
			FieldLabels:    true,
		},
	}

	// 2. Tenant Policy inherits from global-base, overrides Scope and Limit
	nodes["tenant-acme"] = &PolicyNode{
		ID:       "tenant-acme",
		ParentID: "global-base",
		Layer:    LayerTenant,
		Policy: Policy{
			ID:     "tenant-acme",
			Tenant: "acme",
			Scope:  ScopeClient,
			Limit:  500,
			Burst:  500,
			Labels: map[string]string{"tenant": "acme"},
		},
		Specified: map[string]bool{
			FieldScope:  true,
			FieldLimit:  true,
			FieldBurst:  true,
			FieldLabels: true,
		},
	}

	// 3. Route Policy inherits from tenant-acme, overrides Burst only
	nodes["route-checkout"] = &PolicyNode{
		ID:       "route-checkout",
		ParentID: "tenant-acme",
		Layer:    LayerRoute,
		Policy: Policy{
			ID:     "route-checkout",
			Tenant: "acme",
			Burst:  600, // Child explicitly overrides burst, inherits limit 500
			Labels: map[string]string{"route": "checkout"},
		},
		Specified: map[string]bool{
			FieldBurst:  true,
			FieldLabels: true,
		},
	}

	eff, err := ComputeEffectivePolicy("route-checkout", nodes)
	if err != nil {
		t.Fatalf("ComputeEffectivePolicy failed: %v", err)
	}

	// Verify fields
	if eff.Policy.Algorithm != AlgorithmTokenBucket {
		t.Fatalf("expected inherited algorithm token_bucket, got %s", eff.Policy.Algorithm)
	}
	if eff.Policy.Scope != ScopeClient {
		t.Fatalf("expected tenant overridden scope client, got %s", eff.Policy.Scope)
	}
	if eff.Policy.Limit != 500 {
		t.Fatalf("expected tenant overridden limit 500, got %d", eff.Policy.Limit)
	}
	if eff.Policy.Burst != 600 {
		t.Fatalf("expected route overridden burst 600, got %d", eff.Policy.Burst)
	}
	if eff.Policy.Window != time.Minute {
		t.Fatalf("expected global window 1m, got %v", eff.Policy.Window)
	}

	// Verify Provenance
	if eff.Provenance[FieldAlgorithm] != "global:global-base" {
		t.Fatalf("expected algorithm provenance global:global-base, got %s", eff.Provenance[FieldAlgorithm])
	}
	if eff.Provenance[FieldScope] != "tenant:tenant-acme" {
		t.Fatalf("expected scope provenance tenant:tenant-acme, got %s", eff.Provenance[FieldScope])
	}
	if eff.Provenance[FieldLimit] != "tenant:tenant-acme" {
		t.Fatalf("expected limit provenance tenant:tenant-acme, got %s", eff.Provenance[FieldLimit])
	}
	if eff.Provenance[FieldBurst] != "route:route-checkout" {
		t.Fatalf("expected burst provenance route:route-checkout, got %s", eff.Provenance[FieldBurst])
	}
	if eff.Provenance["labels.source"] != "global:global-base" {
		t.Fatalf("expected labels.source from global, got %s", eff.Provenance["labels.source"])
	}
	if eff.Provenance["labels.route"] != "route:route-checkout" {
		t.Fatalf("expected labels.route from route, got %s", eff.Provenance["labels.route"])
	}
}

func TestPolicyInheritanceCycleDetection(t *testing.T) {
	nodes := map[string]*PolicyNode{
		"node-a": {
			ID:       "node-a",
			ParentID: "node-b",
			Layer:    LayerTenant,
		},
		"node-b": {
			ID:       "node-b",
			ParentID: "node-c",
			Layer:    LayerEnvironment,
		},
		"node-c": {
			ID:       "node-c",
			ParentID: "node-a", // Cycle: a -> b -> c -> a
			Layer:    LayerRoute,
		},
	}

	_, err := ComputeEffectivePolicy("node-a", nodes)
	if err == nil {
		t.Fatalf("expected error on circular inheritance, got nil")
	}
	if !errors.IsCode(err, errors.ErrCodePolicyCycle) {
		t.Fatalf("expected ErrCodePolicyCycle, got: %v", err)
	}
}
