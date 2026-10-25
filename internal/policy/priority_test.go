package policy

import (
	"fmt"
	"math/rand"
	"testing"
)

func TestPriorityOrderingPrecedenceHierarchy(t *testing.T) {
	// Rule 1: Explicit Priority wins over specificity
	r1 := MatchedRoute{
		Policy:      Policy{ID: "pol-high-pri", Priority: 100, Tenant: "global"},
		Specificity: WeightMultiWildcard, // e.g. **
	}
	r2 := MatchedRoute{
		Policy:      Policy{ID: "pol-low-pri", Priority: 10, Tenant: "acme"},
		Specificity: WeightLiteral, // literal exact
	}
	if ComparePriority(r1, r2) >= 0 {
		t.Fatalf("expected explicit priority 100 to beat priority 10 regardless of specificity")
	}

	// Rule 2: When explicit priorities are equal, specificity wins
	r3 := MatchedRoute{
		Policy:      Policy{ID: "pol-lit", Priority: 50, Tenant: "acme"},
		Specificity: WeightLiteral, // 1000
	}
	r4 := MatchedRoute{
		Policy:      Policy{ID: "pol-wild", Priority: 50, Tenant: "acme"},
		Specificity: WeightParamSingle, // 100
	}
	if ComparePriority(r3, r4) >= 0 {
		t.Fatalf("expected literal specificity to beat param specificity")
	}

	// Rule 3: When priority and specificity are equal, tenant-specific beats global
	r5 := MatchedRoute{
		Policy:      Policy{ID: "pol-tenant", Priority: 50, Tenant: "acme"},
		Specificity: WeightLiteral,
	}
	r6 := MatchedRoute{
		Policy:      Policy{ID: "pol-global", Priority: 50, Tenant: "global"},
		Specificity: WeightLiteral,
	}
	if ComparePriority(r5, r6) >= 0 {
		t.Fatalf("expected tenant-specific to beat global")
	}

	// Rule 4: Deterministic tie-breaker on ID ascending
	r7 := MatchedRoute{
		Policy:      Policy{ID: "pol-aaa", Priority: 50, Tenant: "acme", Version: 1},
		Specificity: WeightLiteral,
	}
	r8 := MatchedRoute{
		Policy:      Policy{ID: "pol-bbb", Priority: 50, Tenant: "acme", Version: 1},
		Specificity: WeightLiteral,
	}
	if ComparePriority(r7, r8) >= 0 {
		t.Fatalf("expected pol-aaa to beat pol-bbb")
	}
}

func TestPriorityTotalOrderProperties(t *testing.T) {
	rng := rand.New(rand.NewSource(1337))

	tenants := []string{"global", "acme", "stripe", "uber", "*", ""}
	specificities := []int{WeightLiteral, WeightParamSingle, WeightSuffixWild, WeightMultiWildcard}

	// Generate 100 random distinct policies
	policies := make([]MatchedRoute, 100)
	for i := 0; i < 100; i++ {
		policies[i] = MatchedRoute{
			Policy: Policy{
				ID:       fmt.Sprintf("pol-%04d", i),
				Priority: rng.Intn(10),
				Tenant:   tenants[rng.Intn(len(tenants))],
				Version:  int64(rng.Intn(5) + 1),
			},
			Specificity: specificities[rng.Intn(len(specificities))],
		}
	}

	// Property 1: Reflexivity
	for i := range policies {
		if cmp := ComparePriority(policies[i], policies[i]); cmp != 0 {
			t.Fatalf("reflexivity violation for %s: expected 0, got %d", policies[i].Policy.ID, cmp)
		}
	}

	// Property 2: Antisymmetry
	for i := 0; i < len(policies); i++ {
		for j := 0; j < len(policies); j++ {
			cmpAB := ComparePriority(policies[i], policies[j])
			cmpBA := ComparePriority(policies[j], policies[i])

			if cmpAB < 0 && cmpBA <= 0 {
				t.Fatalf("antisymmetry violation between %d and %d: AB=%d, BA=%d", i, j, cmpAB, cmpBA)
			}
			if cmpAB > 0 && cmpBA >= 0 {
				t.Fatalf("antisymmetry violation between %d and %d: AB=%d, BA=%d", i, j, cmpAB, cmpBA)
			}
			if cmpAB == 0 && cmpBA != 0 {
				t.Fatalf("antisymmetry violation at equality between %d and %d", i, j)
			}
		}
	}

	// Property 3: Transitivity
	for i := 0; i < 50; i++ {
		for j := 0; j < 50; j++ {
			for k := 0; k < 50; k++ {
				a, b, c := policies[i], policies[j], policies[k]
				cmpAB := ComparePriority(a, b)
				cmpBC := ComparePriority(b, c)
				cmpAC := ComparePriority(a, c)

				if cmpAB < 0 && cmpBC < 0 {
					if cmpAC >= 0 {
						t.Fatalf("transitivity violation: A < B and B < C but A >= C (cmpAC=%d)", cmpAC)
					}
				}
			}
		}
	}

	// Property 4: Totality (any two distinct policies have a strict order)
	for i := 0; i < len(policies); i++ {
		for j := i + 1; j < len(policies); j++ {
			cmp := ComparePriority(policies[i], policies[j])
			if cmp == 0 {
				t.Fatalf("totality violation: distinct policies %s and %s produced cmp=0",
					policies[i].Policy.ID, policies[j].Policy.ID)
			}
		}
	}
}
