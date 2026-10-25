package policy

import (
	"testing"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/errors"
)

func TestPolicyOverrideExpiryAndRevocation(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFakeClock(now)

	orig := Policy{
		ID:        "pol-api",
		Tenant:    "acme",
		Limit:     100,
		Burst:     100,
		Algorithm: AlgorithmTokenBucket,
		Scope:     ScopeClient,
		Window:    time.Minute,
	}

	newLimit := int64(180)
	ov := OverrideRecord{
		ID:        "ov-incident-1",
		Tenant:    "acme",
		PolicyID:  "pol-api",
		Owner:     "sre-oncall",
		Reason:    "Black Friday burst",
		CreatedAt: now,
		ExpiresAt: now.Add(15 * time.Minute),
		Limit:     &newLimit,
	}

	// 1. Currently active
	modified, applied := ApplyActiveOverride(orig, ov, clk)
	if !applied || modified.Limit != 180 {
		t.Fatalf("expected override to apply limit 180, applied=%v, limit=%d", applied, modified.Limit)
	}

	// 2. Advance clock past ExpiresAt
	clk.Advance(20 * time.Minute)
	expired, applied := ApplyActiveOverride(orig, ov, clk)
	if applied || expired.Limit != 100 {
		t.Fatalf("expected override to expire, applied=%v, limit=%d", applied, expired.Limit)
	}

	// 3. Reset clock, mark revoked
	clk.Set(now.Add(5 * time.Minute))
	ov.Revoked = true
	revoked, applied := ApplyActiveOverride(orig, ov, clk)
	if applied || revoked.Limit != 100 {
		t.Fatalf("expected revoked override to not apply, applied=%v, limit=%d", applied, revoked.Limit)
	}
}

func TestPolicyOverrideRelaxationGuard(t *testing.T) {
	orig := Policy{
		ID:     "pol-guard",
		Tenant: "acme",
		Limit:  100,
		Burst:  100,
	}

	// Relax by 2.5x without ForceRelax (max factor = 2.0) -> must fail
	tooHigh := int64(250)
	ov := OverrideRecord{
		PolicyID: "pol-guard",
		Tenant:   "acme",
		Limit:    &tooHigh,
	}

	err := ValidateRelaxation(orig, ov, 2.0)
	if err == nil || !errors.IsCode(err, errors.ErrCodeRelaxationExceeded) {
		t.Fatalf("expected ErrCodeRelaxationExceeded on 2.5x relaxation, got: %v", err)
	}

	// Relax by 1.8x without ForceRelax -> allowed
	okLimit := int64(180)
	ov.Limit = &okLimit
	if err := ValidateRelaxation(orig, ov, 2.0); err != nil {
		t.Fatalf("expected 1.8x relaxation to be allowed, got: %v", err)
	}

	// Relax by 5x WITH ForceRelax -> allowed
	extremeLimit := int64(500)
	ov.Limit = &extremeLimit
	ov.ForceRelax = true
	if err := ValidateRelaxation(orig, ov, 2.0); err != nil {
		t.Fatalf("expected ForceRelax to permit extreme relaxation, got: %v", err)
	}
}
