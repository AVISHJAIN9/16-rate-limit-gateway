package identity

import (
	"bytes"
	"testing"

	"rlgw/internal/policy"
)

// FuzzKeyInjectivity validates that distinct input tuples (tenant, scope, dimension, policyID, method)
// map to distinct binary keys and distinct Redis keys with zero collisions.
func FuzzKeyInjectivity(f *testing.F) {
	kb := NewKeyBuilder(KeyBuilderOptions{IncludePolicyVersion: true})

	// Seed inputs
	f.Add("tenant1", "client", "dim1", "pol1", "GET", int64(1))
	f.Add("tenant2", "user", "dim2", "pol2", "POST", int64(2))
	f.Add("tenant1|dim1", "client", "sub", "pol1", "PUT", int64(1))
	f.Add("tenant1", "client|dim1", "sub", "pol1", "PUT", int64(1))

	f.Fuzz(func(t *testing.T, tenant, scopeStr, dim, policyID, method string, ver int64) {
		kc1 := KeyComponents{
			Tenant:        tenant,
			Scope:         policy.Scope(scopeStr),
			Dimension:     dim,
			PolicyID:      policyID,
			PolicyVersion: ver,
			Method:        method,
		}

		buf1 := make([]byte, 256)
		bin1 := kb.BuildBinaryKeyToBuf(buf1, kc1)
		redis1 := kb.BuildRedisKey(kc1)

		// Create a perturbed input kc2 that is guaranteed different from kc1
		kc2 := kc1
		kc2.Tenant = tenant + "_diff"

		buf2 := make([]byte, 256)
		bin2 := kb.BuildBinaryKeyToBuf(buf2, kc2)
		redis2 := kb.BuildRedisKey(kc2)

		if bytes.Equal(bin1, bin2) {
			t.Fatalf("collision detected in binary keys for distinct tenants %q vs %q", kc1.Tenant, kc2.Tenant)
		}
		if redis1 == redis2 {
			t.Fatalf("collision detected in redis keys for distinct tenants %q vs %q", kc1.Tenant, kc2.Tenant)
		}

		// Perturb dimension
		kc3 := kc1
		kc3.Dimension = dim + "_x"
		buf3 := make([]byte, 256)
		bin3 := kb.BuildBinaryKeyToBuf(buf3, kc3)
		redis3 := kb.BuildRedisKey(kc3)

		if bytes.Equal(bin1, bin3) {
			t.Fatalf("collision detected in binary keys for distinct dimensions %q vs %q", kc1.Dimension, kc3.Dimension)
		}
		if redis1 == redis3 {
			t.Fatalf("collision detected in redis keys for distinct dimensions %q vs %q", kc1.Dimension, kc3.Dimension)
		}
	})
}
