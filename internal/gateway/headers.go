package gateway

import (
	"crypto/rand"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/identity"
	"rlgw/internal/store"
)

// HeaderFormatMode controls which rate limit headers are emitted in responses.
type HeaderFormatMode string

const (
	HeaderFormatIETF   HeaderFormatMode = "ietf"
	HeaderFormatLegacy HeaderFormatMode = "legacy"
	HeaderFormatBoth   HeaderFormatMode = "both"
	HeaderFormatNone   HeaderFormatMode = "none"
)

const (
	MaxHeaderCount       = 100
	MaxHeaderValueLength = 8192
	MaxRequestIDLength   = 128
	MaxAPIKeyLength      = 256
)

// HeaderParser handles secure parsing and sanitization of ingress HTTP headers.
type HeaderParser struct {
	trustedProxy identity.TrustedProxyChecker
	reqIDHeader  string
}

// NewHeaderParser constructs a HeaderParser.
func NewHeaderParser(trustedProxy identity.TrustedProxyChecker, reqIDHeader string) *HeaderParser {
	if trustedProxy == nil {
		trustedProxy = identity.NewUntrustedProxyChecker()
	}
	if reqIDHeader == "" {
		reqIDHeader = "X-Request-Id"
	}
	return &HeaderParser{
		trustedProxy: trustedProxy,
		reqIDHeader:  http.CanonicalHeaderKey(reqIDHeader),
	}
}

// GenerateUUIDv4 generates a compliant RFC 4122 v4 UUID string.
func GenerateUUIDv4() string {
	var uuid [16]byte
	_, _ = rand.Read(uuid[:])
	uuid[6] = (uuid[6] & 0x0f) | 0x40 // Version 4
	uuid[8] = (uuid[8] & 0x3f) | 0x80 // Variant 10xx
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		uuid[0:4], uuid[4:6], uuid[6:8], uuid[8:10], uuid[10:16])
}

// SanitizeRequestID validates and returns a safe request ID. If invalid or missing, generates a new UUID.
func SanitizeRequestID(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > MaxRequestIDLength {
		return GenerateUUIDv4()
	}
	for i := 0; i < len(raw); i++ {
		b := raw[i]
		if !((b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '-' || b == '_' || b == '.') {
			return GenerateUUIDv4()
		}
	}
	return raw
}

// ExtractOrGenerateRequestID extracts X-Request-Id or injects a new UUID.
func (p *HeaderParser) ExtractOrGenerateRequestID(req *http.Request) string {
	if req == nil || req.Header == nil {
		return GenerateUUIDv4()
	}
	raw := req.Header.Get(p.reqIDHeader)
	reqID := SanitizeRequestID(raw)
	req.Header.Set(p.reqIDHeader, reqID)
	return reqID
}

// ParsedAuth holds extracted authentication scheme and credentials.
type ParsedAuth struct {
	Scheme      string
	Credentials string
}

// ExtractAuthorization extracts the scheme and credential token from the Authorization header.
func ExtractAuthorization(req *http.Request) ParsedAuth {
	if req == nil || req.Header == nil {
		return ParsedAuth{}
	}
	auth := strings.TrimSpace(req.Header.Get("Authorization"))
	if auth == "" || len(auth) > MaxHeaderValueLength {
		return ParsedAuth{}
	}
	parts := strings.SplitN(auth, " ", 2)
	if len(parts) == 1 {
		return ParsedAuth{Scheme: strings.TrimSpace(parts[0])}
	}
	return ParsedAuth{
		Scheme:      strings.TrimSpace(parts[0]),
		Credentials: strings.TrimSpace(parts[1]),
	}
}

// ExtractAPIKey extracts and bounds the API key from X-Api-Key or Authorization header.
func ExtractAPIKey(req *http.Request) string {
	if req == nil || req.Header == nil {
		return ""
	}
	if key := strings.TrimSpace(req.Header.Get("X-Api-Key")); key != "" {
		if len(key) <= MaxAPIKeyLength {
			return key
		}
		return key[:MaxAPIKeyLength]
	}
	auth := ExtractAuthorization(req)
	if strings.EqualFold(auth.Scheme, "ApiKey") || strings.EqualFold(auth.Scheme, "Bearer") {
		if len(auth.Credentials) <= MaxAPIKeyLength {
			return auth.Credentials
		}
		return auth.Credentials[:MaxAPIKeyLength]
	}
	return ""
}

// ParseContentLength parses and audits Content-Length header. Returns -1 if absent, or -2 if invalid/negative.
func ParseContentLength(req *http.Request) int64 {
	if req == nil || req.Header == nil {
		return -1
	}
	clStr := strings.TrimSpace(req.Header.Get("Content-Length"))
	if clStr == "" {
		return -1
	}
	val, err := strconv.ParseInt(clStr, 10, 64)
	if err != nil || val < 0 {
		return -2
	}
	return val
}

// PolicyDecisionOutcome bundles a policy metadata with its evaluated decision.
type PolicyDecisionOutcome struct {
	PolicyID   string
	Tenant     string
	Limit      int64
	Window     time.Duration
	Decision   store.Decision
	RetryAfter time.Duration
}

// HeaderEmitter writes standard rate limit response headers.
type HeaderEmitter struct {
	format HeaderFormatMode
	clk    clock.Clock
}

// NewHeaderEmitter constructs a HeaderEmitter.
func NewHeaderEmitter(format HeaderFormatMode, clk clock.Clock) *HeaderEmitter {
	if format == "" {
		format = HeaderFormatBoth
	}
	if clk == nil {
		clk = clock.NewRealClock()
	}
	return &HeaderEmitter{
		format: format,
		clk:    clk,
	}
}

// SelectMostConstraining selects the policy outcome with the strictest rate limit status.
func SelectMostConstraining(outcomes []PolicyDecisionOutcome) *PolicyDecisionOutcome {
	if len(outcomes) == 0 {
		return nil
	}
	if len(outcomes) == 1 {
		return &outcomes[0]
	}

	// 1. If any denied, select the denied outcome with the largest RetryAfter
	var mostConstrainedDenied *PolicyDecisionOutcome
	for i := range outcomes {
		if !outcomes[i].Decision.Allowed {
			if mostConstrainedDenied == nil || outcomes[i].RetryAfter > mostConstrainedDenied.RetryAfter {
				mostConstrainedDenied = &outcomes[i]
			}
		}
	}
	if mostConstrainedDenied != nil {
		return mostConstrainedDenied
	}

	// 2. If all allowed, select the outcome with lowest Remaining (or soonest ResetAfter)
	mostConstrained := &outcomes[0]
	for i := 1; i < len(outcomes); i++ {
		cur := &outcomes[i]
		if cur.Decision.Remaining < mostConstrained.Decision.Remaining {
			mostConstrained = cur
		} else if cur.Decision.Remaining == mostConstrained.Decision.Remaining {
			if cur.Decision.ResetAfter < mostConstrained.Decision.ResetAfter {
				mostConstrained = cur
			}
		}
	}
	return mostConstrained
}

// WriteResponseHeaders emits IETF and/or Legacy rate limit response headers on w.
func (e *HeaderEmitter) WriteResponseHeaders(w http.ResponseWriter, callerTenant string, outcome *PolicyDecisionOutcome) {
	if e.format == HeaderFormatNone || outcome == nil {
		return
	}

	h := w.Header()

	// Tenant privacy guard: don't leak other tenants' policy IDs
	policyLabel := outcome.PolicyID
	if outcome.Tenant != "" && outcome.Tenant != "global" && outcome.Tenant != callerTenant {
		policyLabel = "protected"
	}

	limit := outcome.Limit
	remaining := outcome.Decision.Remaining
	if remaining < 0 {
		remaining = 0
	}

	// Reset in seconds (integer ceil)
	resetSec := int64(math.Ceil(outcome.Decision.ResetAfter.Seconds()))
	if resetSec <= 0 {
		resetSec = 1
	}

	windowSec := int64(math.Ceil(outcome.Window.Seconds()))
	if windowSec <= 0 {
		windowSec = 1
	}

	// Write IETF Draft headers
	if e.format == HeaderFormatIETF || e.format == HeaderFormatBoth {
		h.Set("RateLimit-Limit", fmt.Sprintf("%d;w=%d", limit, windowSec))
		h.Set("RateLimit-Remaining", strconv.FormatInt(remaining, 10))
		h.Set("RateLimit-Reset", strconv.FormatInt(resetSec, 10))
		h.Set("RateLimit-Policy", fmt.Sprintf(`"%d;w=%d;policy=\"%s\""`, limit, windowSec, policyLabel))
	}

	// Write Legacy X-RateLimit-* headers
	if e.format == HeaderFormatLegacy || e.format == HeaderFormatBoth {
		h.Set("X-RateLimit-Limit", strconv.FormatInt(limit, 10))
		h.Set("X-RateLimit-Remaining", strconv.FormatInt(remaining, 10))
		resetEpoch := e.clk.Now().Add(outcome.Decision.ResetAfter).Unix()
		h.Set("X-RateLimit-Reset", strconv.FormatInt(resetEpoch, 10))
	}

	// If rate-limited, emit Retry-After and Cache-Control
	if !outcome.Decision.Allowed {
		retrySec := int64(math.Ceil(outcome.RetryAfter.Seconds()))
		if retrySec <= 0 {
			retrySec = 1
		}
		h.Set("Retry-After", strconv.FormatInt(retrySec, 10))
		h.Set("Cache-Control", "no-store, no-cache, must-revalidate")
		h.Set("Pragma", "no-cache")
	}
}
