package policy

import (
	"fmt"

	"rlgw/internal/clock"
	"rlgw/internal/errors"
)

const DefaultMaxRelaxFactor = 2.0

// ValidateRelaxation ensures that a temporary override does not exceed the allowed relaxation factor
// unless explicitly authorized via ForceRelax.
func ValidateRelaxation(orig Policy, ov OverrideRecord, maxRelaxFactor float64) error {
	if ov.ForceRelax {
		return nil
	}
	if maxRelaxFactor <= 1.0 {
		maxRelaxFactor = DefaultMaxRelaxFactor
	}

	if ov.Limit != nil && *ov.Limit > 0 && orig.Limit > 0 {
		maxLimit := int64(float64(orig.Limit) * maxRelaxFactor)
		if *ov.Limit > maxLimit {
			return errors.New(errors.ErrCodeRelaxationExceeded,
				fmt.Sprintf("override limit %d exceeds max relaxation factor %.1fx (max allowed %d) without force_relax",
					*ov.Limit, maxRelaxFactor, maxLimit))
		}
	}

	if ov.Burst != nil && *ov.Burst > 0 && orig.Burst > 0 {
		maxBurst := int64(float64(orig.Burst) * maxRelaxFactor)
		if *ov.Burst > maxBurst {
			return errors.New(errors.ErrCodeRelaxationExceeded,
				fmt.Sprintf("override burst %d exceeds max relaxation factor %.1fx (max allowed %d) without force_relax",
					*ov.Burst, maxRelaxFactor, maxBurst))
		}
	}

	return nil
}

// IsOverrideActive tests whether an override is currently unrevoked and not expired.
func IsOverrideActive(ov OverrideRecord, clk clock.Clock) bool {
	if ov.Revoked {
		return false
	}
	now := clk.Now()
	if !ov.ExpiresAt.IsZero() && !now.Before(ov.ExpiresAt) {
		return false
	}
	return true
}

// ApplyActiveOverride modifies policy limits if the override is currently active.
func ApplyActiveOverride(p Policy, ov OverrideRecord, clk clock.Clock) (Policy, bool) {
	if !IsOverrideActive(ov, clk) {
		return p, false
	}

	applied := false
	if ov.Limit != nil && *ov.Limit > 0 {
		p.Limit = *ov.Limit
		applied = true
	}
	if ov.Burst != nil && *ov.Burst > 0 {
		p.Burst = *ov.Burst
		applied = true
	}
	return p, applied
}
