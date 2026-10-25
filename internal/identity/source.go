package identity

import (
	"context"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"rlgw/internal/errors"
	"rlgw/internal/obs"
)

// IdentitySource defines a pluggable stage in the request identity resolution pipeline.
type IdentitySource interface {
	Name() string
	// Resolve attempts to extract identity dimensions from req into id.
	// Returns (matched bool, err error). When matched is true, the pipeline halts with first-match-wins.
	Resolve(req *http.Request, id *Identity) (bool, error)
}

// APIKeySource extracts API key credentials from precomputed canonical headers or "Authorization: Bearer rlk_...".
type APIKeySource struct {
	lookup          KeyLookup
	header          string
	canonicalHeader string
}

// NewAPIKeySource creates an APIKeySource backed by key lookup.
func NewAPIKeySource(lookup KeyLookup, headerName string) *APIKeySource {
	if headerName == "" {
		headerName = "X-API-Key"
	}
	return &APIKeySource{
		lookup:          lookup,
		header:          headerName,
		canonicalHeader: http.CanonicalHeaderKey(headerName),
	}
}

func (s *APIKeySource) Name() string {
	return "api_key"
}

func (s *APIKeySource) Resolve(req *http.Request, id *Identity) (bool, error) {
	var raw string
	if vals := req.Header[s.canonicalHeader]; len(vals) > 0 {
		raw = vals[0]
	}
	if raw == "" {
		// Check Authorization: Bearer rlk_...
		if authVals := req.Header["Authorization"]; len(authVals) > 0 {
			auth := authVals[0]
			if strings.HasPrefix(auth, "Bearer rlk_") {
				raw = auth[7:]
			}
		}
	}
	if raw == "" {
		return false, nil
	}

	parsed, err := ParseAPIKey(raw)
	if err != nil {
		return false, err
	}

	keyMeta, err := s.lookup.LookupKey(req.Context(), parsed.KeyID)
	if err != nil {
		return false, err
	}

	id.APIKeyID = keyMeta.KeyID
	id.ClientID = keyMeta.ClientID
	id.Tenant = keyMeta.Tenant
	id.Source = "api_key"
	return true, nil
}

// UserIDSource extracts User ID from an incoming request header.
// By default, AllowUntrusted is false, meaning untrusted headers are rejected.
type UserIDSource struct {
	HeaderName      string
	canonicalHeader string
	AllowUntrusted  bool
}

// NewUserIDSource creates a UserIDSource.
func NewUserIDSource(headerName string, allowUntrusted bool) *UserIDSource {
	if headerName == "" {
		headerName = "X-User-ID"
	}
	return &UserIDSource{
		HeaderName:      headerName,
		canonicalHeader: http.CanonicalHeaderKey(headerName),
		AllowUntrusted:  allowUntrusted,
	}
}

func (s *UserIDSource) Name() string {
	return "user_header"
}

func (s *UserIDSource) Resolve(req *http.Request, id *Identity) (bool, error) {
	var val string
	if vals := req.Header[s.canonicalHeader]; len(vals) > 0 {
		val = vals[0]
	}
	if val == "" {
		return false, nil
	}

	if !s.AllowUntrusted {
		return false, errors.Wrap(errors.ErrCodeUntrustedHeader, "untrusted user-id header rejected by policy", nil)
	}

	id.UserID = val
	id.Source = "user_header"
	return true, nil
}

// IPSource extracts and normalizes the client IP address from RemoteAddr or trusted proxy headers.
type IPSource struct {
	proxyChecker   TrustedProxyChecker
	ipv6PrefixBits int
}

// NewIPSource creates an IPSource with configurable proxy checking and IPv6 prefix aggregation.
func NewIPSource(checker TrustedProxyChecker, ipv6PrefixBits int) *IPSource {
	if checker == nil {
		checker = NewUntrustedProxyChecker()
	}
	if ipv6PrefixBits <= 0 {
		ipv6PrefixBits = DefaultIPv6PrefixBits
	}
	return &IPSource{
		proxyChecker:   checker,
		ipv6PrefixBits: ipv6PrefixBits,
	}
}

func (s *IPSource) Name() string {
	return "ip_fallback"
}

func (s *IPSource) Resolve(req *http.Request, id *Identity) (bool, error) {
	var clientIP netip.Addr

	// Parse RemoteAddr
	remoteAddr := req.RemoteAddr
	if remoteAddr != "" {
		if ap, err := netip.ParseAddrPort(remoteAddr); err == nil {
			clientIP = ap.Addr()
		} else if addr, err := netip.ParseAddr(remoteAddr); err == nil {
			clientIP = addr
		}
	}

	// Only inspect X-Forwarded-For if the immediate hop is trusted
	if clientIP.IsValid() && s.proxyChecker.IsTrusted(clientIP) {
		if xffVals := req.Header["X-Forwarded-For"]; len(xffVals) > 0 {
			xff := xffVals[0]
			idx := strings.IndexByte(xff, ',')
			clientPart := xff
			if idx != -1 {
				clientPart = strings.TrimSpace(xff[:idx])
			}
			if addr, err := netip.ParseAddr(clientPart); err == nil {
				clientIP = addr
			}
		}
	}

	if !clientIP.IsValid() {
		return false, nil
	}

	id.IP = NormalizeAddr(clientIP, s.ipv6PrefixBits)
	if id.Source == "" {
		id.Source = "ip_fallback"
	}
	return true, nil
}

// Resolver orchestrates an ordered pipeline of identity resolution stages.
// Pipeline order: API key -> JWT -> mTLS -> IP fallback.
type Resolver struct {
	stages   []IdentitySource
	ipSource *IPSource
	recorder obs.Recorder
}

// NewResolver constructs a Resolver pipeline.
func NewResolver(stages []IdentitySource, ipSource *IPSource, recorder obs.Recorder) *Resolver {
	if recorder == nil {
		recorder = obs.NewNoOpRecorder()
	}
	return &Resolver{
		stages:   stages,
		ipSource: ipSource,
		recorder: recorder,
	}
}

// Resolve executes the identity pipeline on req, populating target.
// Target must be allocated by the caller (or reset) to guarantee 0 heap allocations on the hot path.
func (r *Resolver) Resolve(ctx context.Context, req *http.Request, target *Identity) error {
	start := time.Now()
	matched := false

	// Evaluate ordered stages: first-match-wins
	for _, stage := range r.stages {
		m, err := stage.Resolve(req, target)
		if err != nil {
			r.recorder.RecordResolution(ctx, stage.Name(), false, time.Since(start))
			return err
		}
		if m {
			matched = true
			r.recorder.RecordResolution(ctx, stage.Name(), true, time.Since(start))
			break
		}
	}

	// Ensure IP address is always populated as network context/fallback
	if r.ipSource != nil {
		_, _ = r.ipSource.Resolve(req, target)
	}

	// Capture route and method from request if present
	if target.Method == "" {
		target.Method = req.Method
	}

	if !matched && target.Source == "" && target.IP.IsValid() {
		target.Source = "ip_fallback"
	}

	return nil
}
