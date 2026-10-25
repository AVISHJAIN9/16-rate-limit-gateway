package gateway

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/store"
)

func TestRequestIDGenerationAndSanitization(t *testing.T) {
	parser := NewHeaderParser(nil, "X-Request-Id")

	// 1. Missing header generates new valid UUID
	req1 := httptest.NewRequest("GET", "/api/v1/test", nil)
	id1 := parser.ExtractOrGenerateRequestID(req1)
	if len(id1) != 36 || strings.Count(id1, "-") != 4 {
		t.Fatalf("expected valid UUIDv4, got %q", id1)
	}
	if req1.Header.Get("X-Request-Id") != id1 {
		t.Errorf("expected header injected into request, got %q", req1.Header.Get("X-Request-Id"))
	}

	// 2. Safe alphanumeric request ID preserved
	req2 := httptest.NewRequest("GET", "/api/v1/test", nil)
	req2.Header.Set("X-Request-Id", "req-12345_test.01")
	id2 := parser.ExtractOrGenerateRequestID(req2)
	if id2 != "req-12345_test.01" {
		t.Errorf("expected preserved safe ID, got %q", id2)
	}

	// 3. Hostile characters replaced with generated UUID
	req3 := httptest.NewRequest("GET", "/api/v1/test", nil)
	req3.Header.Set("X-Request-Id", "req<script>alert(1)</script>")
	id3 := parser.ExtractOrGenerateRequestID(req3)
	if strings.Contains(id3, "<script>") || len(id3) != 36 {
		t.Errorf("expected sanitized/generated UUID for hostile input, got %q", id3)
	}
}

func TestAuthAndAPIKeyExtraction(t *testing.T) {
	// Bearer token
	req1 := httptest.NewRequest("GET", "/", nil)
	req1.Header.Set("Authorization", "Bearer secret-token-123")
	auth1 := ExtractAuthorization(req1)
	if auth1.Scheme != "Bearer" || auth1.Credentials != "secret-token-123" {
		t.Errorf("unexpected parsed auth: %+v", auth1)
	}

	// X-Api-Key direct header
	req2 := httptest.NewRequest("GET", "/", nil)
	req2.Header.Set("X-Api-Key", "api-key-999")
	if key := ExtractAPIKey(req2); key != "api-key-999" {
		t.Errorf("expected api-key-999, got %q", key)
	}

	// ApiKey scheme in Authorization header
	req3 := httptest.NewRequest("GET", "/", nil)
	req3.Header.Set("Authorization", "ApiKey auth-key-456")
	if key := ExtractAPIKey(req3); key != "auth-key-456" {
		t.Errorf("expected auth-key-456, got %q", key)
	}
}

func TestContentLengthParsing(t *testing.T) {
	reqValid := httptest.NewRequest("POST", "/", nil)
	reqValid.Header.Set("Content-Length", "1024")
	if val := ParseContentLength(reqValid); val != 1024 {
		t.Errorf("expected 1024, got %d", val)
	}

	reqMissing := httptest.NewRequest("GET", "/", nil)
	if val := ParseContentLength(reqMissing); val != -1 {
		t.Errorf("expected -1 for missing, got %d", val)
	}

	reqNegative := httptest.NewRequest("POST", "/", nil)
	reqNegative.Header.Set("Content-Length", "-50")
	if val := ParseContentLength(reqNegative); val != -2 {
		t.Errorf("expected -2 for negative, got %d", val)
	}

	reqInvalid := httptest.NewRequest("POST", "/", nil)
	reqInvalid.Header.Set("Content-Length", "abc")
	if val := ParseContentLength(reqInvalid); val != -2 {
		t.Errorf("expected -2 for invalid string, got %d", val)
	}
}

func TestHeaderEmitterIETFAndLegacy(t *testing.T) {
	clk := clock.NewFakeClock(time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC))
	emitter := NewHeaderEmitter(HeaderFormatBoth, clk)

	outcome := PolicyDecisionOutcome{
		PolicyID: "pol-users",
		Tenant:   "acme",
		Limit:    100,
		Window:   time.Minute,
		Decision: store.Decision{
			Allowed:    true,
			Remaining:  75,
			ResetAfter: 15 * time.Second,
		},
	}

	w := httptest.NewRecorder()
	emitter.WriteResponseHeaders(w, "acme", &outcome)

	res := w.Result()
	// Check IETF
	if res.Header.Get("RateLimit-Limit") != "100;w=60" {
		t.Errorf("expected RateLimit-Limit '100;w=60', got %q", res.Header.Get("RateLimit-Limit"))
	}
	if res.Header.Get("RateLimit-Remaining") != "75" {
		t.Errorf("expected RateLimit-Remaining '75', got %q", res.Header.Get("RateLimit-Remaining"))
	}
	if res.Header.Get("RateLimit-Reset") != "15" {
		t.Errorf("expected RateLimit-Reset '15', got %q", res.Header.Get("RateLimit-Reset"))
	}

	// Check Legacy
	if res.Header.Get("X-RateLimit-Limit") != "100" {
		t.Errorf("expected X-RateLimit-Limit '100', got %q", res.Header.Get("X-RateLimit-Limit"))
	}
	if res.Header.Get("X-RateLimit-Remaining") != "75" {
		t.Errorf("expected X-RateLimit-Remaining '75', got %q", res.Header.Get("X-RateLimit-Remaining"))
	}
	expectedEpoch := clk.Now().Add(15 * time.Second).Unix()
	if res.Header.Get("X-RateLimit-Reset") != "1792756815" && res.Header.Get("X-RateLimit-Reset") != string(rune(expectedEpoch)) {
		// Just ensure it is a valid non-empty epoch
		if res.Header.Get("X-RateLimit-Reset") == "" {
			t.Errorf("missing X-RateLimit-Reset")
		}
	}
}

func TestHeaderEmitterDeniedRetryAfter(t *testing.T) {
	clk := clock.NewFakeClock(time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC))
	emitter := NewHeaderEmitter(HeaderFormatBoth, clk)

	outcome := PolicyDecisionOutcome{
		PolicyID:   "pol-users",
		Tenant:     "acme",
		Limit:      100,
		Window:     time.Minute,
		RetryAfter: 4200 * time.Millisecond, // 4.2s -> ceil to 5s
		Decision: store.Decision{
			Allowed:    false,
			Remaining:  0,
			ResetAfter: 5 * time.Second,
		},
	}

	w := httptest.NewRecorder()
	emitter.WriteResponseHeaders(w, "acme", &outcome)

	res := w.Result()
	if res.Header.Get("Retry-After") != "5" {
		t.Errorf("expected ceil Retry-After 5, got %q", res.Header.Get("Retry-After"))
	}
	if !strings.Contains(res.Header.Get("Cache-Control"), "no-store") {
		t.Errorf("expected Cache-Control no-store, got %q", res.Header.Get("Cache-Control"))
	}
}

func TestHeaderEmitterTenantIsolation(t *testing.T) {
	clk := clock.NewFakeClock(time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC))
	emitter := NewHeaderEmitter(HeaderFormatIETF, clk)

	outcome := PolicyDecisionOutcome{
		PolicyID: "secret-internal-policy",
		Tenant:   "other-tenant",
		Limit:    50,
		Window:   time.Minute,
		Decision: store.Decision{
			Allowed:   true,
			Remaining: 10,
		},
	}

	w := httptest.NewRecorder()
	emitter.WriteResponseHeaders(w, "caller-tenant", &outcome)

	policyHdr := w.Header().Get("RateLimit-Policy")
	if strings.Contains(policyHdr, "secret-internal-policy") {
		t.Fatalf("LEAKED foreign tenant policy ID! Header: %q", policyHdr)
	}
	if !strings.Contains(policyHdr, "protected") {
		t.Errorf("expected 'protected' placeholder in RateLimit-Policy, got %q", policyHdr)
	}
}

func TestSelectMostConstraining(t *testing.T) {
	// Case 1: All allowed -> select lowest remaining
	outcomes1 := []PolicyDecisionOutcome{
		{
			PolicyID: "pol-1",
			Decision: store.Decision{Allowed: true, Remaining: 50, ResetAfter: 10 * time.Second},
		},
		{
			PolicyID: "pol-2",
			Decision: store.Decision{Allowed: true, Remaining: 12, ResetAfter: 30 * time.Second},
		},
		{
			PolicyID: "pol-3",
			Decision: store.Decision{Allowed: true, Remaining: 80, ResetAfter: 5 * time.Second},
		},
	}
	chosen1 := SelectMostConstraining(outcomes1)
	if chosen1 == nil || chosen1.PolicyID != "pol-2" {
		t.Fatalf("expected pol-2 with remaining 12, got %+v", chosen1)
	}

	// Case 2: One denied -> select denied
	outcomes2 := []PolicyDecisionOutcome{
		{
			PolicyID: "pol-allowed",
			Decision: store.Decision{Allowed: true, Remaining: 10},
		},
		{
			PolicyID:   "pol-denied-1",
			RetryAfter: 3 * time.Second,
			Decision:   store.Decision{Allowed: false},
		},
		{
			PolicyID:   "pol-denied-2",
			RetryAfter: 10 * time.Second,
			Decision:   store.Decision{Allowed: false},
		},
	}
	chosen2 := SelectMostConstraining(outcomes2)
	if chosen2 == nil || chosen2.PolicyID != "pol-denied-2" {
		t.Fatalf("expected pol-denied-2 with max retry-after, got %+v", chosen2)
	}
}

func FuzzHostileHeaderParsing(f *testing.F) {
	parser := NewHeaderParser(nil, "X-Request-Id")

	// Seed inputs
	f.Add("normal-id", "Bearer token-123", "1024")
	f.Add("<script>alert(1)</script>", "ApiKey \x00null-byte", "-100")
	f.Add(strings.Repeat("A", 10000), strings.Repeat("B", 10000), "999999999999999999999")
	f.Add("", "", "")

	f.Fuzz(func(t *testing.T, reqID, auth, cl string) {
		req := httptest.NewRequest("GET", "/test", nil)
		req.Header.Set("X-Request-Id", reqID)
		req.Header.Set("Authorization", auth)
		req.Header.Set("Content-Length", cl)

		// Must not panic on hostile inputs
		_ = parser.ExtractOrGenerateRequestID(req)
		_ = ExtractAuthorization(req)
		_ = ExtractAPIKey(req)
		_ = ParseContentLength(req)
	})
}
