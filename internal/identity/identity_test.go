package identity

import (
	"bytes"
	"context"
	"net/http"
	"net/netip"
	"strings"
	"testing"

	"rlgw/internal/errors"
	"rlgw/internal/policy"
)

func TestAPIKeyParsingAndRedaction(t *testing.T) {
	raw := "rlk_user123_sec9876543210"
	parsed, err := ParseAPIKey(raw)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}

	if parsed.KeyID != "user123" {
		t.Fatalf("expected keyID 'user123', got %q", parsed.KeyID)
	}
	if parsed.Secret != "sec9876543210" {
		t.Fatalf("expected secret 'sec9876543210', got %q", parsed.Secret)
	}

	// Verify redacted string does NOT leak secret
	redacted := parsed.String()
	if strings.Contains(redacted, "sec9876543210") {
		t.Fatalf("CRITICAL SECURITY LEAK: String() leaked raw secret: %s", redacted)
	}
	if redacted != "rlk_user123_***REDACTED***" {
		t.Fatalf("unexpected redacted format: %s", redacted)
	}

	// Malformed keys
	invalidKeys := []string{
		"",
		"bearer_foo_bar",
		"rlk_",
		"rlk_onepart",
		"rlk_two_parts_too_many",
		"rlk__secret",
		"rlk_id_",
	}
	for _, bad := range invalidKeys {
		_, err := ParseAPIKey(bad)
		if err == nil {
			t.Fatalf("expected error for malformed key %q", bad)
		}
	}
}

func TestIPNormalizationMatrix(t *testing.T) {
	matrix := []struct {
		name       string
		raw        string
		prefixBits int
		expected   string
	}{
		{
			name:       "standard IPv4",
			raw:        "192.0.2.1",
			prefixBits: 64,
			expected:   "192.0.2.1",
		},
		{
			name:       "IPv4 with port",
			raw:        "198.51.100.4:8080",
			prefixBits: 64,
			expected:   "198.51.100.4",
		},
		{
			name:       "IPv4-mapped IPv6 normalization",
			raw:        "::ffff:192.0.2.128",
			prefixBits: 64,
			expected:   "192.0.2.128",
		},
		{
			name:       "IPv4-mapped IPv6 with brackets and port",
			raw:        "[::ffff:203.0.113.19]:443",
			prefixBits: 64,
			expected:   "203.0.113.19",
		},
		{
			name:       "IPv6 default /64 subnet aggregation",
			raw:        "2001:db8:85a3:8d3:1319:8a2e:370:7348",
			prefixBits: 64,
			expected:   "2001:db8:85a3:8d3::",
		},
		{
			name:       "IPv6 /64 aggregation preserves first 64 bits",
			raw:        "2001:db8:abcd:0012:ffff:ffff:ffff:ffff",
			prefixBits: 64,
			expected:   "2001:db8:abcd:12::",
		},
		{
			name:       "IPv6 /48 aggregation",
			raw:        "2001:db8:abcd:1234::1",
			prefixBits: 48,
			expected:   "2001:db8:abcd::",
		},
		{
			name:       "IPv6 /128 (exact host, no aggregation)",
			raw:        "2001:db8::1",
			prefixBits: 128,
			expected:   "2001:db8::1",
		},
	}

	for _, tc := range matrix {
		t.Run(tc.name, func(t *testing.T) {
			addr, err := ParseAndNormalizeIP(tc.raw, tc.prefixBits)
			if err != nil {
				t.Fatalf("failed parsing %q: %v", tc.raw, err)
			}
			if addr.String() != tc.expected {
				t.Fatalf("expected normalized IP %q, got %q", tc.expected, addr.String())
			}
		})
	}
}

func TestScopeKeyerMatrix(t *testing.T) {
	baseID := Identity{
		Tenant:   "tenant-corp",
		ClientID: "client-abc",
		UserID:   "user-999",
		IP:       netip.MustParseAddr("192.0.2.50"),
		Route:    "/api/v1/orders/{orderId}",
		Method:   "POST",
		Group:    "orders_group",
	}

	tests := []struct {
		name      string
		scope     policy.Scope
		expected  string
		mutateID  func(id *Identity)
		policyOpt func(p *policy.Policy)
		wantSkip  bool
		wantDeny  bool
	}{
		// F9 Global
		{name: "F9 Global scope", scope: policy.ScopeGlobal, expected: "global"},
		// F10 Client
		{name: "F10 Client scope present", scope: policy.ScopeClient, expected: "client-abc"},
		{name: "F10 Client scope missing with default deny", scope: policy.ScopeClient, mutateID: func(id *Identity) { id.ClientID = "" }, wantDeny: true},
		{name: "F10 Client scope missing with skip", scope: policy.ScopeClient, mutateID: func(id *Identity) { id.ClientID = "" }, policyOpt: func(p *policy.Policy) { p.OnMissingIdentity = policy.OnMissingSkip }, wantSkip: true},
		{name: "F10 Client scope missing with fallback to IP", scope: policy.ScopeClient, mutateID: func(id *Identity) { id.ClientID = "" }, policyOpt: func(p *policy.Policy) { p.OnMissingIdentity = policy.OnMissingFallbackIP }, expected: "ip:192.0.2.50"},
		// F11 User
		{name: "F11 User scope present", scope: policy.ScopeUser, expected: "user-999"},
		{name: "F11 User scope missing deny", scope: policy.ScopeUser, mutateID: func(id *Identity) { id.UserID = "" }, wantDeny: true},
		// F12 IP
		{name: "F12 IP scope present", scope: policy.ScopeIP, expected: "192.0.2.50"},
		{name: "F12 IP scope missing deny", scope: policy.ScopeIP, mutateID: func(id *Identity) { id.IP = netip.Addr{} }, wantDeny: true},
		// F13 Route
		{name: "F13 Route template scope present", scope: policy.ScopeRoute, expected: "/api/v1/orders/{orderId}"},
		{name: "F13 Route scope missing deny", scope: policy.ScopeRoute, mutateID: func(id *Identity) { id.Route = "" }, wantDeny: true},
		// F14 Tenant
		{name: "F14 Tenant scope aggregate present", scope: policy.ScopeTenant, expected: "tenant-corp"},
		{name: "F14 Tenant scope missing deny", scope: policy.ScopeTenant, mutateID: func(id *Identity) { id.Tenant = "" }, wantDeny: true},
		// F15 Endpoint Group
		{name: "F15 Endpoint group scope present", scope: policy.ScopeEndpointGroup, expected: "orders_group"},
		{name: "F15 Endpoint group missing deny", scope: policy.ScopeEndpointGroup, mutateID: func(id *Identity) { id.Group = "" }, wantDeny: true},
		// F8 Method
		{name: "F8 Method scope present", scope: policy.ScopeMethod, expected: "POST"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			id := baseID
			if tc.mutateID != nil {
				tc.mutateID(&id)
			}
			p := policy.Policy{
				ID:                "test-pol",
				Scope:             tc.scope,
				OnMissingIdentity: policy.OnMissingDeny,
			}
			if tc.policyOpt != nil {
				tc.policyOpt(&p)
			}

			keyer, err := GetScopeKeyer(tc.scope)
			if err != nil {
				t.Fatalf("unexpected keyer lookup error: %v", err)
			}

			res, err := keyer.ExtractDimension(&id, &p)

			if tc.wantDeny {
				if err == nil || !res.Deny || !errors.IsCode(err, errors.ErrCodeMissingDimension) {
					t.Fatalf("expected deny error with ErrCodeMissingDimension, got res=%+v, err=%v", res, err)
				}
				return
			}
			if tc.wantSkip {
				if err != nil || !res.Skip {
					t.Fatalf("expected skip with nil error, got res=%+v, err=%v", res, err)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if res.Dimension != tc.expected {
				t.Fatalf("expected dimension %q, got %q", tc.expected, res.Dimension)
			}
		})
	}
}

func TestKeyBuilderBinaryAndRedisHashTag(t *testing.T) {
	kb := NewKeyBuilder(KeyBuilderOptions{
		IncludePolicyVersion: false,
		Namespace:            "rl",
	})

	kc := KeyComponents{
		Tenant:        "acme",
		Scope:         policy.ScopeClient,
		Dimension:     "client-1",
		PolicyID:      "pol-orders",
		PolicyVersion: 2,
		Method:        "GET",
		Attributes: map[string]string{
			"env":    "prod",
			"region": "us-east-1",
		},
	}

	// 1. Check Redis cluster hash-tag format
	redisKey := kb.BuildRedisKey(kc)
	expectedRedis := "rl:{acme:client-1}:client:pol-orders:GET"
	if redisKey != expectedRedis {
		t.Fatalf("expected Redis key %q, got %q", expectedRedis, redisKey)
	}

	// 2. Binary key generation with reusable buffer
	buf := make([]byte, 256)
	binKey := kb.BuildBinaryKeyToBuf(buf, kc)
	if len(binKey) == 0 {
		t.Fatal("empty binary key")
	}
	if binKey[0] != BinaryKeyWireVersion {
		t.Fatalf("expected wire version %x, got %x", BinaryKeyWireVersion, binKey[0])
	}

	// 3. Order-independence of attributes: change insertion order, binary key MUST match exactly
	kcReordered := kc
	kcReordered.Attributes = map[string]string{
		"region": "us-east-1",
		"env":    "prod",
	}
	buf2 := make([]byte, 256)
	binKey2 := kb.BuildBinaryKeyToBuf(buf2, kcReordered)

	if !bytes.Equal(binKey, binKey2) {
		t.Fatalf("binary keys differ due to map order: %x vs %x", binKey, binKey2)
	}
}

func TestResolverPipelineStages(t *testing.T) {
	keyStore := NewInMemoryKeyLookup()
	keyStore.RegisterKey(APIKey{
		KeyID:    "key123",
		ClientID: "client_alpha",
		Tenant:   "tenant_corp",
	})

	apiSource := NewAPIKeySource(keyStore, "X-API-Key")
	userSource := NewUserIDSource("X-User-ID", false) // Untrusted rejected
	ipSource := NewIPSource(NewUntrustedProxyChecker(), 64)

	resolver := NewResolver([]IdentitySource{apiSource, userSource}, ipSource, nil)

	// Case 1: Valid API Key in Header
	req, _ := http.NewRequest("GET", "/test", nil)
	req.Header.Set("X-API-Key", "rlk_key123_secretxyz")
	req.RemoteAddr = "203.0.113.10:1234"

	var id Identity
	err := resolver.Resolve(context.Background(), req, &id)
	if err != nil {
		t.Fatalf("resolve err: %v", err)
	}
	if id.Source != "api_key" || id.ClientID != "client_alpha" || id.Tenant != "tenant_corp" {
		t.Fatalf("unexpected identity resolution: %+v", id)
	}
	if id.IP.String() != "203.0.113.10" {
		t.Fatalf("expected IP populated: %v", id.IP)
	}

	// Case 2: Untrusted User ID rejected by default
	req2, _ := http.NewRequest("GET", "/test", nil)
	req2.Header.Set("X-User-ID", "attacker_user")
	var id2 Identity
	err2 := resolver.Resolve(context.Background(), req2, &id2)
	if err2 == nil || !errors.IsCode(err2, errors.ErrCodeUntrustedHeader) {
		t.Fatalf("expected ErrCodeUntrustedHeader, got %v", err2)
	}

	// Case 3: IP fallback when no credentials provided
	req3, _ := http.NewRequest("POST", "/test", nil)
	req3.RemoteAddr = "192.0.2.1:5000"
	var id3 Identity
	err3 := resolver.Resolve(context.Background(), req3, &id3)
	if err3 != nil {
		t.Fatalf("unexpected err3: %v", err3)
	}
	if id3.Source != "ip_fallback" || id3.IP.String() != "192.0.2.1" {
		t.Fatalf("unexpected IP fallback identity: %+v", id3)
	}
}

func BenchmarkResolverHotPath(b *testing.B) {
	keyStore := NewInMemoryKeyLookup()
	keyStore.RegisterKey(APIKey{
		KeyID:    "benchkey",
		ClientID: "bench_client",
		Tenant:   "bench_tenant",
	})
	apiSource := NewAPIKeySource(keyStore, "X-API-Key")
	ipSource := NewIPSource(NewUntrustedProxyChecker(), 64)
	resolver := NewResolver([]IdentitySource{apiSource}, ipSource, nil)

	req, _ := http.NewRequest("GET", "/api/v1/bench", nil)
	req.Header.Set("X-API-Key", "rlk_benchkey_secret999")
	req.RemoteAddr = "192.0.2.55:12345"

	ctx := context.Background()
	target := &Identity{}

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		target.Reset()
		if err := resolver.Resolve(ctx, req, target); err != nil {
			b.Fatalf("resolve failed: %v", err)
		}
	}
}

func BenchmarkKeyBuilderBinaryKeyHotPath(b *testing.B) {
	kb := NewKeyBuilder(KeyBuilderOptions{})
	kc := KeyComponents{
		Tenant:    "tenant_a",
		Scope:     policy.ScopeClient,
		Dimension: "client_999",
		PolicyID:  "pol_test",
		Method:    "GET",
	}

	buf := make([]byte, 256)
	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		res := kb.BuildBinaryKeyToBuf(buf, kc)
		if len(res) == 0 {
			b.Fatal("unexpected empty key")
		}
	}
}
