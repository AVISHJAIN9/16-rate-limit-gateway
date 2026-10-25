package policy

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

func TestRadixTreeBasicMatchingAndParamExtraction(t *testing.T) {
	tree := NewRadixTree()

	// Register routes
	tree.Insert("/users/profile", []string{"GET"}, "", Policy{ID: "pol-literal"})
	tree.Insert("/users/{id}", []string{"GET", "POST"}, "", Policy{ID: "pol-param"})
	tree.Insert("/files/{path...}", []string{"GET"}, "", Policy{ID: "pol-multi"})
	tree.Insert("/static/*.png", []string{"GET"}, "", Policy{ID: "pol-suffix"})
	tree.Insert("/admin/*", []string{"DELETE"}, "", Policy{ID: "pol-wildcard"})

	// 1. Exact literal match
	m1 := tree.Match("GET", "/users/profile", "")
	if len(m1) == 0 {
		t.Fatalf("expected match for /users/profile")
	}
	// Literal match should be found and have higher specificity than param
	hasLiteral := false
	for _, m := range m1 {
		if m.Policy.ID == "pol-literal" {
			hasLiteral = true
		}
	}
	if !hasLiteral {
		t.Fatalf("expected pol-literal in matches")
	}

	// 2. Param extraction
	m2 := tree.Match("GET", "/users/42", "")
	if len(m2) == 0 {
		t.Fatalf("expected match for /users/42")
	}
	var paramRoute *MatchedRoute
	for i := range m2 {
		if m2[i].Policy.ID == "pol-param" {
			paramRoute = &m2[i]
			break
		}
	}
	if paramRoute == nil {
		t.Fatalf("expected pol-param in matches for /users/42")
	}
	params := paramRoute.ExtractedParams()
	if len(params) != 1 || params[0].Key != "id" || params[0].Value != "42" {
		t.Fatalf("expected extracted param id=42, got %+v", params)
	}

	// 3. Multi-segment wildcard extraction
	m3 := tree.Match("GET", "/files/docs/2026/report.pdf", "")
	if len(m3) == 0 {
		t.Fatalf("expected match for /files/docs/2026/report.pdf")
	}
	var multiRoute *MatchedRoute
	for i := range m3 {
		if m3[i].Policy.ID == "pol-multi" {
			multiRoute = &m3[i]
			break
		}
	}
	if multiRoute == nil {
		t.Fatalf("expected pol-multi match")
	}
	mParams := multiRoute.ExtractedParams()
	if len(mParams) != 1 || mParams[0].Key != "path" || mParams[0].Value != "docs/2026/report.pdf" {
		t.Fatalf("expected path='docs/2026/report.pdf', got %+v", mParams)
	}

	// 4. Suffix wildcard match
	m4 := tree.Match("GET", "/static/logo.png", "")
	hasSuffix := false
	for _, m := range m4 {
		if m.Policy.ID == "pol-suffix" {
			hasSuffix = true
		}
	}
	if !hasSuffix {
		t.Fatalf("expected pol-suffix match for /static/logo.png")
	}

	// 5. Method filtering: POST on /static/logo.png should NOT match
	m5 := tree.Match("POST", "/static/logo.png", "")
	if len(m5) != 0 {
		t.Fatalf("expected 0 matches for POST on GET-only route, got %d", len(m5))
	}
}

// NaiveLinearMatcher is the test oracle that tests route patterns linearly.
type NaiveLinearMatcher struct {
	rules []linearRule
}

type linearRule struct {
	pattern string
	methods map[string]struct{}
	policy  Policy
}

func newNaiveLinearMatcher() *NaiveLinearMatcher {
	return &NaiveLinearMatcher{}
}

func (m *NaiveLinearMatcher) Add(pattern string, methods []string, pol Policy) {
	rule := linearRule{
		pattern: pattern,
		methods: make(map[string]struct{}),
		policy:  pol,
	}
	for _, meth := range methods {
		rule.methods[strings.ToUpper(meth)] = struct{}{}
	}
	m.rules = append(m.rules, rule)
}

func (m *NaiveLinearMatcher) Match(method, path string) ([]Policy, map[string]string) {
	var matched []Policy
	params := make(map[string]string)

	cleanPath := strings.Trim(path, "/")
	var pathSegs []string
	if cleanPath != "" {
		pathSegs = strings.Split(cleanPath, "/")
	}

	method = strings.ToUpper(method)

	for _, rule := range m.rules {
		if len(rule.methods) > 0 {
			if _, ok := rule.methods[method]; !ok {
				continue
			}
		}

		cleanPat := strings.Trim(rule.pattern, "/")
		var patSegs []string
		if cleanPat != "" {
			patSegs = strings.Split(cleanPat, "/")
		}

		ruleParams := make(map[string]string)
		matches := matchLinearSegments(patSegs, pathSegs, ruleParams)
		if matches {
			matched = append(matched, rule.policy)
			for k, v := range ruleParams {
				params[k] = v
			}
		}
	}

	return matched, params
}

func matchLinearSegments(patSegs, pathSegs []string, params map[string]string) bool {
	pIdx := 0
	sIdx := 0

	for pIdx < len(patSegs) {
		pSeg := patSegs[pIdx]

		if pSeg == "**" || (strings.HasPrefix(pSeg, "{") && strings.HasSuffix(pSeg, "...}")) {
			paramName := "path"
			if strings.HasPrefix(pSeg, "{") {
				paramName = pSeg[1 : len(pSeg)-4]
			}
			remaining := ""
			if sIdx < len(pathSegs) {
				remaining = strings.Join(pathSegs[sIdx:], "/")
			}
			params[paramName] = remaining
			return true
		}

		if sIdx >= len(pathSegs) {
			return false
		}

		sSeg := pathSegs[sIdx]

		if strings.HasPrefix(pSeg, "*.") {
			suffix := pSeg[1:]
			if !strings.HasSuffix(sSeg, suffix) {
				return false
			}
		} else if strings.HasPrefix(pSeg, "{") && strings.HasSuffix(pSeg, "}") {
			paramName := pSeg[1 : len(pSeg)-1]
			params[paramName] = sSeg
		} else if pSeg == "*" {
			// matches single segment
		} else {
			if pSeg != sSeg {
				return false
			}
		}

		pIdx++
		sIdx++
	}

	return pIdx == len(patSegs) && sIdx == len(pathSegs)
}

func TestRadixTreeFuzzAgainstLinearOracle100k(t *testing.T) {
	rng := rand.New(rand.NewSource(42))

	routePatterns := []string{
		"/users",
		"/users/{id}",
		"/users/{id}/profile",
		"/users/{id}/orders/{order_id}",
		"/items/*",
		"/items/*/download",
		"/static/*.png",
		"/static/*.css",
		"/assets/{path...}",
		"/api/v1/auth/login",
		"/api/v1/auth/logout",
		"/api/v1/billing/{account_id}/invoices",
		"/healthz",
		"/readyz",
		"/metrics",
	}

	tree := NewRadixTree()
	oracle := newNaiveLinearMatcher()

	methods := []string{"GET", "POST", "DELETE"}

	for i, pat := range routePatterns {
		method := methods[i%len(methods)]
		pol := Policy{ID: fmt.Sprintf("pol-%d", i), Priority: i}
		tree.Insert(pat, []string{method}, "", pol)
		oracle.Add(pat, []string{method}, pol)
	}

	sampleSegments := []string{
		"users", "123", "456", "profile", "orders", "order_999",
		"items", "item_a", "download", "static", "image.png", "style.css",
		"assets", "css", "bundle.min.js", "api", "v1", "auth", "login",
		"billing", "acc_77", "invoices", "healthz", "unknown", "extra",
	}

	const iterations = 100000

	for i := 0; i < iterations; i++ {
		// Generate random path
		depth := rng.Intn(5) + 1
		segs := make([]string, depth)
		for d := 0; d < depth; d++ {
			segs[d] = sampleSegments[rng.Intn(len(sampleSegments))]
		}
		path := "/" + strings.Join(segs, "/")
		method := methods[rng.Intn(len(methods))]

		// Query radix tree
		radixMatches := tree.Match(method, path, "")

		// Query oracle
		oracleMatches, _ := oracle.Match(method, path)

		// Assert equality of match counts
		if len(radixMatches) != len(oracleMatches) {
			t.Fatalf("iteration %d: mismatch for %s %s: radix matches=%d, oracle matches=%d",
				i, method, path, len(radixMatches), len(oracleMatches))
		}

		// Verify that all policies matched by oracle are present in radix matches
		radixPolicyMap := make(map[string]bool)
		for _, rm := range radixMatches {
			radixPolicyMap[rm.Policy.ID] = true
		}

		for _, op := range oracleMatches {
			if !radixPolicyMap[op.ID] {
				t.Fatalf("iteration %d: policy %s matched by oracle but not by radix for %s %s",
					i, op.ID, method, path)
			}
		}
	}
}
