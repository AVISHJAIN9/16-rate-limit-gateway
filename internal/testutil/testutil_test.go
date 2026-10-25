package testutil

import (
	"testing"

	"rlgw/internal/policy"
)

func TestTestutilFixtures(t *testing.T) {
	fc := NewTestClock()
	if fc.Now().Year() != 2026 {
		t.Fatalf("expected year 2026, got %d", fc.Now().Year())
	}

	p := ValidTestPolicy("pol-test", policy.ScopeClient)
	if errs := p.Validate(); len(errs) > 0 {
		t.Fatalf("expected valid policy fixture, got errors: %v", errs)
	}

	id := SampleIdentity("t1", "c1", "u1")
	if id.ClientID != "c1" || id.Tenant != "t1" || id.UserID != "u1" {
		t.Fatalf("unexpected sample identity: %+v", id)
	}

	rng := SeededRand(t)
	val := rng.Intn(100)
	if val < 0 || val >= 100 {
		t.Fatalf("rng out of bounds: %d", val)
	}
}
