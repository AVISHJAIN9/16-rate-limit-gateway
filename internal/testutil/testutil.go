package testutil

import (
	"math/rand"
	"net/netip"
	"testing"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/identity"
	"rlgw/internal/policy"
)

// SeededRand creates a deterministically seeded rand.Rand and registers a cleanup to print the seed if the test fails.
func SeededRand(t testing.TB) *rand.Rand {
	t.Helper()
	seed := time.Now().UnixNano()
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("Deterministic test failed! Reproduce with seed: %d", seed)
		}
	})
	return rand.New(rand.NewSource(seed))
}

// NewTestClock returns a FakeClock initialized to a standard deterministic timestamp.
func NewTestClock() *clock.FakeClock {
	return clock.NewFakeClock(time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC))
}

// ValidTestPolicy returns a pre-configured valid Policy value.
func ValidTestPolicy(id string, scope policy.Scope) policy.Policy {
	return policy.Policy{
		ID:        id,
		Name:      "Test Policy " + id,
		Version:   1,
		Tenant:    "test-tenant",
		Scope:     scope,
		Algorithm: policy.AlgorithmTokenBucket,
		Limit:     100,
		Window:    time.Minute,
		Burst:     150,
		CostSpec: policy.CostSpec{
			Mode:        "static",
			StaticCost:  1,
			DefaultCost: 1,
			MaxCost:     10,
		},
		OnReject: policy.OnRejectSpec{
			Status:         429,
			BodyTemplateID: "throttled_default",
			RetryAfterMode: "seconds",
		},
		Priority: 10,
		Enabled:  true,
		Labels: map[string]string{
			"env": "test",
		},
		OnMissingIdentity: policy.OnMissingDeny,
	}
}

// SampleIdentity returns an Identity fixture populated with standard testing dimensions.
func SampleIdentity(tenant, clientID, userID string) identity.Identity {
	return identity.Identity{
		Tenant:     tenant,
		ClientID:   clientID,
		APIKeyID:   "key_" + clientID,
		UserID:     userID,
		IP:         netip.MustParseAddr("192.0.2.1"),
		Route:      "/api/v1/resource/{id}",
		Method:     "GET",
		Group:      "default_group",
		Source:     "api_key",
		Attributes: map[string]string{"env": "test"},
	}
}
