package policy

import (
	"strings"
	"testing"
	"time"
)

func validBasePolicy() Policy {
	return Policy{
		ID:        "pol-standard-user",
		Name:      "Standard User Rate Limit",
		Version:   1,
		Tenant:    "tenant-prod-1",
		Scope:     ScopeUser,
		Algorithm: AlgorithmTokenBucket,
		Limit:     100,
		Window:    time.Minute,
		Burst:     150,
		CostSpec: CostSpec{
			Mode:        "static",
			StaticCost:  1,
			DefaultCost: 1,
			MaxCost:     10,
		},
		OnReject: OnRejectSpec{
			Status:         429,
			BodyTemplateID: "default_throttled",
			RetryAfterMode: "seconds",
		},
		Priority: 10,
		Enabled:  true,
		Labels: map[string]string{
			"tier": "free",
		},
		OnMissingIdentity: OnMissingDeny,
	}
}

func TestPolicyValidationMatrix40Cases(t *testing.T) {
	tests := []struct {
		name          string
		mutate        func(p *Policy)
		expectedField string
		shouldPass    bool
	}{
		// 1. Happy path
		{name: "valid baseline policy", mutate: func(p *Policy) {}, shouldPass: true},
		// 2-5: ID checks
		{name: "empty ID", mutate: func(p *Policy) { p.ID = "" }, expectedField: "id"},
		{name: "whitespace ID", mutate: func(p *Policy) { p.ID = "   " }, expectedField: "id"},
		{name: "overlong ID > 64", mutate: func(p *Policy) { p.ID = strings.Repeat("a", 65) }, expectedField: "id"},
		{name: "max length ID 64", mutate: func(p *Policy) { p.ID = strings.Repeat("a", 64) }, shouldPass: true},
		// 6-9: Name checks
		{name: "empty name", mutate: func(p *Policy) { p.Name = "" }, expectedField: "name"},
		{name: "whitespace name", mutate: func(p *Policy) { p.Name = "\t  " }, expectedField: "name"},
		{name: "overlong name > 128", mutate: func(p *Policy) { p.Name = strings.Repeat("x", 129) }, expectedField: "name"},
		{name: "exact 128 char name", mutate: func(p *Policy) { p.Name = strings.Repeat("x", 128) }, shouldPass: true},
		// 10-12: Version checks
		{name: "zero version", mutate: func(p *Policy) { p.Version = 0 }, expectedField: "version"},
		{name: "negative version", mutate: func(p *Policy) { p.Version = -5 }, expectedField: "version"},
		{name: "positive version", mutate: func(p *Policy) { p.Version = 42 }, shouldPass: true},
		// 13-16: Tenant checks
		{name: "empty tenant", mutate: func(p *Policy) { p.Tenant = "" }, expectedField: "tenant"},
		{name: "overlong tenant > 64", mutate: func(p *Policy) { p.Tenant = strings.Repeat("t", 65) }, expectedField: "tenant"},
		{name: "exact 64 tenant", mutate: func(p *Policy) { p.Tenant = strings.Repeat("t", 64) }, shouldPass: true},
		// 17-21: Algorithm checks
		{name: "empty algorithm", mutate: func(p *Policy) { p.Algorithm = "" }, expectedField: "algorithm"},
		{name: "unknown algorithm", mutate: func(p *Policy) { p.Algorithm = "hyper_log_log" }, expectedField: "algorithm"},
		{name: "valid fixed_window", mutate: func(p *Policy) { p.Algorithm = AlgorithmFixedWindow; p.Burst = p.Limit }, shouldPass: true},
		{name: "valid leaky_bucket", mutate: func(p *Policy) { p.Algorithm = AlgorithmLeakyBucket; p.Burst = 10 }, shouldPass: true},
		{name: "valid gcra", mutate: func(p *Policy) { p.Algorithm = AlgorithmGCRA; p.Burst = 200 }, shouldPass: true},
		{name: "valid sliding_window_counter", mutate: func(p *Policy) { p.Algorithm = AlgorithmSlidingWindowCounter; p.Burst = p.Limit }, shouldPass: true},
		{name: "valid sliding_window_log", mutate: func(p *Policy) { p.Algorithm = AlgorithmSlidingWindowLog; p.Burst = p.Limit }, shouldPass: true},
		// 22-25: Scope checks
		{name: "empty scope", mutate: func(p *Policy) { p.Scope = "" }, expectedField: "scope"},
		{name: "unknown scope", mutate: func(p *Policy) { p.Scope = "geo_continent" }, expectedField: "scope"},
		{name: "valid scope client", mutate: func(p *Policy) { p.Scope = ScopeClient }, shouldPass: true},
		{name: "valid scope ip", mutate: func(p *Policy) { p.Scope = ScopeIP }, shouldPass: true},
		{name: "valid scope route", mutate: func(p *Policy) { p.Scope = ScopeRoute }, shouldPass: true},
		{name: "valid scope tenant", mutate: func(p *Policy) { p.Scope = ScopeTenant }, shouldPass: true},
		{name: "valid scope global", mutate: func(p *Policy) { p.Scope = ScopeGlobal }, shouldPass: true},
		{name: "valid scope endpoint_group", mutate: func(p *Policy) { p.Scope = ScopeEndpointGroup }, shouldPass: true},
		// 26-28: Limit checks
		{name: "zero limit", mutate: func(p *Policy) { p.Limit = 0 }, expectedField: "limit"},
		{name: "negative limit", mutate: func(p *Policy) { p.Limit = -1 }, expectedField: "limit"},
		{name: "positive limit 1", mutate: func(p *Policy) { p.Limit = 1; p.Burst = 1 }, shouldPass: true},
		// 29-33: Window checks
		{name: "window below 1ms", mutate: func(p *Policy) { p.Window = 500 * time.Microsecond }, expectedField: "window"},
		{name: "window zero", mutate: func(p *Policy) { p.Window = 0 }, expectedField: "window"},
		{name: "window exact min 1ms", mutate: func(p *Policy) { p.Window = time.Millisecond }, shouldPass: true},
		{name: "window above 366 days", mutate: func(p *Policy) { p.Window = 367 * 24 * time.Hour }, expectedField: "window"},
		{name: "window exact max 366 days", mutate: func(p *Policy) { p.Window = 366 * 24 * time.Hour }, shouldPass: true},
		// 34-37: Burst checks
		{name: "token_bucket burst less than limit", mutate: func(p *Policy) { p.Algorithm = AlgorithmTokenBucket; p.Limit = 100; p.Burst = 99 }, expectedField: "burst"},
		{name: "gcra burst less than limit", mutate: func(p *Policy) { p.Algorithm = AlgorithmGCRA; p.Limit = 50; p.Burst = 40 }, expectedField: "burst"},
		{name: "leaky_bucket zero burst", mutate: func(p *Policy) { p.Algorithm = AlgorithmLeakyBucket; p.Burst = 0 }, expectedField: "burst"},
		{name: "fixed_window negative burst", mutate: func(p *Policy) { p.Algorithm = AlgorithmFixedWindow; p.Burst = -1 }, expectedField: "burst"},
		// 38-41: CostSpec checks
		{name: "negative static cost", mutate: func(p *Policy) { p.CostSpec.StaticCost = -1 }, expectedField: "cost_spec.static_cost"},
		{name: "negative default cost", mutate: func(p *Policy) { p.CostSpec.DefaultCost = -2 }, expectedField: "cost_spec.default_cost"},
		{name: "negative max cost", mutate: func(p *Policy) { p.CostSpec.MaxCost = -3 }, expectedField: "cost_spec.max_cost"},
		{name: "header mode missing header_key", mutate: func(p *Policy) { p.CostSpec.Mode = "header"; p.CostSpec.HeaderKey = "" }, expectedField: "cost_spec.header_key"},
		{name: "header mode valid header_key", mutate: func(p *Policy) { p.CostSpec.Mode = "header"; p.CostSpec.HeaderKey = "X-Request-Cost" }, shouldPass: true},
		// 42-45: OnReject checks
		{name: "invalid status code < 400", mutate: func(p *Policy) { p.OnReject.Status = 200 }, expectedField: "on_reject.status"},
		{name: "invalid status code > 599", mutate: func(p *Policy) { p.OnReject.Status = 600 }, expectedField: "on_reject.status"},
		{name: "valid status code 503", mutate: func(p *Policy) { p.OnReject.Status = 503 }, shouldPass: true},
		{name: "invalid retry after mode", mutate: func(p *Policy) { p.OnReject.RetryAfterMode = "epoch_millis" }, expectedField: "on_reject.retry_after_mode"},
		// 46-49: RoutePattern and Regex complexity checks
		{name: "route pattern exceeding 256", mutate: func(p *Policy) { p.Match.RoutePattern = strings.Repeat("a", 257) }, expectedField: "match.route_pattern"},
		{name: "catastrophic regex backtracking (a+)+", mutate: func(p *Policy) { p.Match.RoutePattern = "^(a+)+$" }, expectedField: "match.route_pattern"},
		{name: "catastrophic regex backtracking (a*)*", mutate: func(p *Policy) { p.Match.RoutePattern = "^(a*)*$" }, expectedField: "match.route_pattern"},
		{name: "invalid regex syntax", mutate: func(p *Policy) { p.Match.RoutePattern = "[unclosed-bracket" }, expectedField: "match.route_pattern"},
		{name: "valid safe route pattern", mutate: func(p *Policy) { p.Match.RoutePattern = "^/api/v1/users/[0-9]+$" }, shouldPass: true},
		// 50-52: Methods and OnMissingIdentity
		{name: "invalid HTTP method FOOBAR", mutate: func(p *Policy) { p.Match.Methods = []string{"GET", "FOOBAR"} }, expectedField: "match.methods"},
		{name: "valid methods lowercase normalized", mutate: func(p *Policy) { p.Match.Methods = []string{"get", "POST"} }, shouldPass: true},
		{name: "invalid on_missing_identity", mutate: func(p *Policy) { p.OnMissingIdentity = "ignore" }, expectedField: "on_missing_identity"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			pol := validBasePolicy()
			tc.mutate(&pol)
			errs := pol.Validate()

			if tc.shouldPass {
				if len(errs) > 0 {
					t.Fatalf("expected pass, got errors: %v", errs)
				}
			} else {
				if len(errs) == 0 {
					t.Fatalf("expected validation failure for field %q, but got 0 errors", tc.expectedField)
				}
				found := false
				for _, e := range errs {
					if e.Field == tc.expectedField {
						found = true
						break
					}
				}
				if !found {
					t.Fatalf("expected error on field %q, got errors: %v", tc.expectedField, errs)
				}
			}
		})
	}
}

func TestPolicyValidationReturnsAllErrors(t *testing.T) {
	// A policy with 5 distinct violations must return at least 5 errors
	broken := Policy{
		ID:        "",                        // violation 1: empty id
		Name:      "",                        // violation 2: empty name
		Version:   -1,                        // violation 3: invalid version
		Tenant:    "",                        // violation 4: empty tenant
		Algorithm: "invalid_algo",            // violation 5: unknown algo
		Scope:     "invalid_scope",           // violation 6: unknown scope
		Limit:     0,                         // violation 7: limit <= 0
		Window:    100 * time.Microsecond,    // violation 8: window < 1ms
		OnReject:  OnRejectSpec{Status: 200}, // violation 9: status < 400
	}

	errs := broken.Validate()
	if len(errs) < 9 {
		t.Fatalf("expected at least 9 accumulated errors, got %d: %v", len(errs), errs)
	}
}

func TestCanonicalJSONAndContentHashStability(t *testing.T) {
	p1 := validBasePolicy()
	p1.Labels = map[string]string{
		"zebra": "z",
		"alpha": "a",
		"beta":  "b",
	}
	p1.Match.Methods = []string{"POST", "GET", "DELETE"}

	p2 := validBasePolicy()
	p2.Labels = map[string]string{
		"alpha": "a",
		"beta":  "b",
		"zebra": "z",
	}
	p2.Match.Methods = []string{"GET", "DELETE", "POST"}

	json1, err := p1.CanonicalJSON()
	if err != nil {
		t.Fatalf("failed json1: %v", err)
	}

	json2, err := p2.CanonicalJSON()
	if err != nil {
		t.Fatalf("failed json2: %v", err)
	}

	if string(json1) != string(json2) {
		t.Fatalf("expected canonical JSON to be identical regardless of insertion order:\n1: %s\n2: %s", string(json1), string(json2))
	}

	hash1, err := p1.ContentHash()
	if err != nil {
		t.Fatalf("hash1 err: %v", err)
	}
	hash2, err := p2.ContentHash()
	if err != nil {
		t.Fatalf("hash2 err: %v", err)
	}

	if hash1 != hash2 {
		t.Fatalf("expected identical content hashes: %s vs %s", hash1, hash2)
	}

	// Change one character in p2: hash MUST change
	p2.Limit = 101
	hash3, _ := p2.ContentHash()
	if hash3 == hash1 {
		t.Fatalf("expected hash to change upon limit change")
	}
}

func BenchmarkPolicyValidation(t *testing.B) {
	p := validBasePolicy()
	t.ResetTimer()
	t.ReportAllocs()

	for i := 0; i < t.N; i++ {
		errs := p.Validate()
		if len(errs) > 0 {
			t.Fatalf("unexpected validation error: %v", errs)
		}
	}
}

func BenchmarkCanonicalJSON(t *testing.B) {
	p := validBasePolicy()
	t.ResetTimer()
	t.ReportAllocs()

	for i := 0; i < t.N; i++ {
		_, err := p.CanonicalJSON()
		if err != nil {
			t.Fatalf("canonical json failed: %v", err)
		}
	}
}
