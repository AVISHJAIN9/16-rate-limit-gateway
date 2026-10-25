package policy

import (
	"strings"
)

// ComparePriority defines a deterministic strict total order between two matched policies.
func ComparePriority(a, b MatchedRoute) int {
	// 1. Explicit Priority
	if a.Policy.Priority != b.Policy.Priority {
		if a.Policy.Priority > b.Policy.Priority {
			return -1
		}
		return 1
	}

	// 2. Specificity
	if a.Specificity != b.Specificity {
		if a.Specificity > b.Specificity {
			return -1
		}
		return 1
	}

	// 3. Tenant-specific over global
	aIsTenant := isTenantScoped(a.Policy.Tenant)
	bIsTenant := isTenantScoped(b.Policy.Tenant)
	if aIsTenant != bIsTenant {
		if aIsTenant {
			return -1
		}
		return 1
	}

	// 4. Deterministic Tie-Breaker: ID ascending
	if a.Policy.ID != b.Policy.ID {
		return strings.Compare(a.Policy.ID, b.Policy.ID)
	}

	// Version descending
	if a.Policy.Version != b.Policy.Version {
		if a.Policy.Version > b.Policy.Version {
			return -1
		}
		return 1
	}

	return 0
}

func isTenantScoped(tenant string) bool {
	t := strings.TrimSpace(tenant)
	return t != "" && !strings.EqualFold(t, "global") && t != "*"
}

// SortMatchedRoutes sorts a slice of matched routes in descending precedence according to the strict total order.
// Uses in-place insertion sort to eliminate reflection heap allocations of sort.Slice.
func SortMatchedRoutes(routes []MatchedRoute) {
	n := len(routes)
	if n <= 1 {
		return
	}
	for i := 1; i < n; i++ {
		for j := i; j > 0 && ComparePriority(routes[j], routes[j-1]) < 0; j-- {
			routes[j], routes[j-1] = routes[j-1], routes[j]
		}
	}
}
