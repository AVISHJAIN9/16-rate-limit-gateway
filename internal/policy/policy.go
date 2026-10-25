package policy

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"regexp/syntax"
	"sort"
	"strings"
	"time"

	"rlgw/internal/errors"
)

// Algorithm enumerates supported rate-limiting algorithms.
type Algorithm string

const (
	AlgorithmTokenBucket          Algorithm = "token_bucket"
	AlgorithmLeakyBucket          Algorithm = "leaky_bucket"
	AlgorithmFixedWindow          Algorithm = "fixed_window"
	AlgorithmSlidingWindowLog     Algorithm = "sliding_window_log"
	AlgorithmSlidingWindowCounter Algorithm = "sliding_window_counter"
	AlgorithmGCRA                 Algorithm = "gcra"
)

// Scope designates the identity dimension keyed by the policy counter.
type Scope string

const (
	ScopeGlobal        Scope = "global"
	ScopeClient        Scope = "client"
	ScopeUser          Scope = "user"
	ScopeIP            Scope = "ip"
	ScopeRoute         Scope = "route"
	ScopeTenant        Scope = "tenant"
	ScopeEndpointGroup Scope = "endpoint_group"
	ScopeMethod        Scope = "method"
)

// MissingIdentityBehavior defines action when an identity dimension is absent.
type MissingIdentityBehavior string

const (
	OnMissingSkip       MissingIdentityBehavior = "skip"
	OnMissingDeny       MissingIdentityBehavior = "deny"
	OnMissingFallbackIP MissingIdentityBehavior = "fallback_to_ip"
)

// MatchSpec specifies traffic routing and environment criteria for policy activation.
type MatchSpec struct {
	Methods      []string `json:"methods,omitempty" yaml:"methods,omitempty"`
	RoutePattern string   `json:"route_pattern,omitempty" yaml:"route_pattern,omitempty"`
	Group        string   `json:"group,omitempty" yaml:"group,omitempty"`
	Env          string   `json:"env,omitempty" yaml:"env,omitempty"`
}

// CostSpec defines how request cost / quota weight is derived.
type CostSpec struct {
	Mode        string `json:"mode,omitempty" yaml:"mode,omitempty"`
	StaticCost  int64  `json:"static_cost,omitempty" yaml:"static_cost,omitempty"`
	HeaderKey   string `json:"header_key,omitempty" yaml:"header_key,omitempty"`
	DefaultCost int64  `json:"default_cost,omitempty" yaml:"default_cost,omitempty"`
	MaxCost     int64  `json:"max_cost,omitempty" yaml:"max_cost,omitempty"`
}

// OnRejectSpec configures response behavior on rate limit exhaustion.
type OnRejectSpec struct {
	Status         int    `json:"status,omitempty" yaml:"status,omitempty"`
	BodyTemplateID string `json:"body_template_id,omitempty" yaml:"body_template_id,omitempty"`
	RetryAfterMode string `json:"retry_after_mode,omitempty" yaml:"retry_after_mode,omitempty"`
}

// Policy is the immutable, validated definition of a rate-limiting contract.
type Policy struct {
	ID                string                  `json:"id"`
	Name              string                  `json:"name"`
	Version           int64                   `json:"version"`
	Tenant            string                  `json:"tenant"`
	Match             MatchSpec               `json:"match"`
	Scope             Scope                   `json:"scope"`
	Algorithm         Algorithm               `json:"algorithm"`
	Limit             int64                   `json:"limit"`
	Window            time.Duration           `json:"window"`
	Burst             int64                   `json:"burst"`
	CostSpec          CostSpec                `json:"cost_spec"`
	OnReject          OnRejectSpec            `json:"on_reject"`
	Priority          int                     `json:"priority"`
	Enabled           bool                    `json:"enabled"`
	Labels            map[string]string       `json:"labels,omitempty"`
	OnMissingIdentity MissingIdentityBehavior `json:"on_missing_identity,omitempty"`
	FailMode          string                  `json:"fail_mode,omitempty" yaml:"fail_mode,omitempty"`
}

// UnmarshalJSON implements json.Unmarshaler supporting both numeric nanoseconds and duration strings (e.g. "1m", "10s").
func (p *Policy) UnmarshalJSON(data []byte) error {
	type rawPolicy Policy
	type alias struct {
		rawPolicy
		Window any `json:"window"`
	}
	var a alias
	if err := json.Unmarshal(data, &a); err != nil {
		return err
	}
	*p = Policy(a.rawPolicy)
	switch v := a.Window.(type) {
	case string:
		d, err := time.ParseDuration(v)
		if err != nil {
			return errors.Wrap(errors.ErrCodePolicyInvalid, fmt.Sprintf("invalid duration string %q: %v", v, err), err)
		}
		p.Window = d
	case float64:
		p.Window = time.Duration(int64(v))
	case int64:
		p.Window = time.Duration(v)
	case nil:
		p.Window = 0
	default:
		return errors.New(errors.ErrCodePolicyInvalid, fmt.Sprintf("unexpected type %T for policy window", v))
	}
	return nil
}


// FieldError records an individual validation violation with its canonical field path.
type FieldError struct {
	Field  string `json:"field"`
	Reason string `json:"reason"`
}

func (f FieldError) String() string {
	return fmt.Sprintf("%s: %s", f.Field, f.Reason)
}

// ValidationErrors aggregates all field validation errors found during policy inspection.
type ValidationErrors []FieldError

func (v ValidationErrors) Error() string {
	if len(v) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(fmt.Sprintf("%d policy validation error(s): ", len(v)))
	for i, fe := range v {
		if i > 0 {
			b.WriteString("; ")
		}
		b.WriteString(fe.String())
	}
	return b.String()
}

const (
	MinWindow       = 1 * time.Millisecond
	MaxWindow       = 366 * 24 * time.Hour
	MaxRoutePatLen  = 256
	MaxRegexProgLen = 500
)

var (
	validMethods = map[string]struct{}{
		"GET": {}, "POST": {}, "PUT": {}, "DELETE": {}, "PATCH": {}, "HEAD": {}, "OPTIONS": {},
	}
	catastrophicRegexPattern = regexp.MustCompile(`\([^\)]*[\+\*][^\)]*\)[\+\*]`)
)

// Validate audits the Policy against all specification constraints and returns ALL failures.
func (p Policy) Validate() ValidationErrors {
	var errs ValidationErrors

	if strings.TrimSpace(p.ID) == "" {
		errs = append(errs, FieldError{Field: "id", Reason: "id is required and cannot be empty"})
	} else if len(p.ID) > 64 {
		errs = append(errs, FieldError{Field: "id", Reason: "id must be <= 64 characters"})
	}

	if strings.TrimSpace(p.Name) == "" {
		errs = append(errs, FieldError{Field: "name", Reason: "name is required and cannot be empty"})
	} else if len(p.Name) > 128 {
		errs = append(errs, FieldError{Field: "name", Reason: "name must be <= 128 characters"})
	}

	if p.Version < 1 {
		errs = append(errs, FieldError{Field: "version", Reason: "version must be >= 1"})
	}

	if strings.TrimSpace(p.Tenant) == "" {
		errs = append(errs, FieldError{Field: "tenant", Reason: "tenant is required and cannot be empty"})
	} else if len(p.Tenant) > 64 {
		errs = append(errs, FieldError{Field: "tenant", Reason: "tenant must be <= 64 characters"})
	}

	// Algorithm validation
	switch p.Algorithm {
	case AlgorithmTokenBucket, AlgorithmLeakyBucket, AlgorithmFixedWindow,
		AlgorithmSlidingWindowLog, AlgorithmSlidingWindowCounter, AlgorithmGCRA:
		// valid
	case "":
		errs = append(errs, FieldError{Field: "algorithm", Reason: "algorithm is required"})
	default:
		errs = append(errs, FieldError{Field: "algorithm", Reason: fmt.Sprintf("unknown algorithm %q", p.Algorithm)})
	}

	// Scope validation
	switch p.Scope {
	case ScopeGlobal, ScopeClient, ScopeUser, ScopeIP, ScopeRoute, ScopeTenant, ScopeEndpointGroup, ScopeMethod:
		// valid
	case "":
		errs = append(errs, FieldError{Field: "scope", Reason: "scope is required"})
	default:
		errs = append(errs, FieldError{Field: "scope", Reason: fmt.Sprintf("unknown scope %q", p.Scope)})
	}

	// Limit validation: zero or negative is invalid
	if p.Limit <= 0 {
		errs = append(errs, FieldError{Field: "limit", Reason: "limit must be strictly positive (> 0)"})
	}

	// Window bounds: 1ms to 366d
	if p.Window < MinWindow {
		errs = append(errs, FieldError{Field: "window", Reason: fmt.Sprintf("window %v is below minimum %v", p.Window, MinWindow)})
	} else if p.Window > MaxWindow {
		errs = append(errs, FieldError{Field: "window", Reason: fmt.Sprintf("window %v exceeds maximum %v", p.Window, MaxWindow)})
	}

	// Burst semantics per algorithm
	switch p.Algorithm {
	case AlgorithmTokenBucket, AlgorithmGCRA:
		if p.Burst < p.Limit {
			errs = append(errs, FieldError{Field: "burst", Reason: fmt.Sprintf("burst (%d) cannot be less than limit (%d) for %s", p.Burst, p.Limit, p.Algorithm)})
		}
	case AlgorithmLeakyBucket:
		if p.Burst <= 0 {
			errs = append(errs, FieldError{Field: "burst", Reason: "burst capacity must be > 0 for leaky_bucket"})
		}
	default:
		if p.Burst < 0 {
			errs = append(errs, FieldError{Field: "burst", Reason: "burst cannot be negative"})
		}
	}

	// CostSpec validation
	if p.CostSpec.StaticCost < 0 {
		errs = append(errs, FieldError{Field: "cost_spec.static_cost", Reason: "static_cost cannot be negative"})
	}
	if p.CostSpec.DefaultCost < 0 {
		errs = append(errs, FieldError{Field: "cost_spec.default_cost", Reason: "default_cost cannot be negative"})
	}
	if p.CostSpec.MaxCost < 0 {
		errs = append(errs, FieldError{Field: "cost_spec.max_cost", Reason: "max_cost cannot be negative"})
	}
	if p.CostSpec.Mode == "header" && strings.TrimSpace(p.CostSpec.HeaderKey) == "" {
		errs = append(errs, FieldError{Field: "cost_spec.header_key", Reason: "header_key is required when cost mode is 'header'"})
	}

	// OnReject validation
	if p.OnReject.Status != 0 {
		if p.OnReject.Status < 400 || p.OnReject.Status > 599 {
			errs = append(errs, FieldError{Field: "on_reject.status", Reason: fmt.Sprintf("status code %d must be an HTTP 4xx or 5xx code", p.OnReject.Status)})
		}
	}
	switch p.OnReject.RetryAfterMode {
	case "", "seconds", "rfc1123", "none":
		// valid
	default:
		errs = append(errs, FieldError{Field: "on_reject.retry_after_mode", Reason: fmt.Sprintf("invalid retry_after_mode %q, expected 'seconds', 'rfc1123', or 'none'", p.OnReject.RetryAfterMode)})
	}

	// Missing identity behavior
	switch p.OnMissingIdentity {
	case "", OnMissingSkip, OnMissingDeny, OnMissingFallbackIP:
		// valid
	default:
		errs = append(errs, FieldError{Field: "on_missing_identity", Reason: fmt.Sprintf("invalid on_missing_identity %q", p.OnMissingIdentity)})
	}

	// Fail mode behavior
	switch p.FailMode {
	case "", "fail_closed", "fail_open", "degrade_local":
		// valid
	default:
		errs = append(errs, FieldError{Field: "fail_mode", Reason: fmt.Sprintf("invalid fail_mode %q, expected 'fail_closed', 'fail_open', or 'degrade_local'", p.FailMode)})
	}

	// Match validation
	for _, m := range p.Match.Methods {
		upper := strings.ToUpper(m)
		if _, ok := validMethods[upper]; !ok {
			errs = append(errs, FieldError{Field: "match.methods", Reason: fmt.Sprintf("invalid HTTP method %q", m)})
		}
	}

	if p.Match.RoutePattern != "" {
		if len(p.Match.RoutePattern) > MaxRoutePatLen {
			errs = append(errs, FieldError{Field: "match.route_pattern", Reason: fmt.Sprintf("route pattern length %d exceeds max %d", len(p.Match.RoutePattern), MaxRoutePatLen)})
		} else if strings.Contains(p.Match.RoutePattern, "**") || strings.Contains(p.Match.RoutePattern, "{") {
			// Radix wildcard route pattern: validate brace balance
			if strings.Count(p.Match.RoutePattern, "{") != strings.Count(p.Match.RoutePattern, "}") {
				errs = append(errs, FieldError{Field: "match.route_pattern", Reason: "unbalanced parameter braces in route pattern"})
			}
		} else {
			// Regular expression route pattern
			if catastrophicRegexPattern.MatchString(p.Match.RoutePattern) {
				errs = append(errs, FieldError{Field: "match.route_pattern", Reason: "route pattern contains nested quantifiers with catastrophic backtracking risk"})
			} else {
				re, err := syntax.Parse(p.Match.RoutePattern, syntax.Perl)
				if err != nil {
					errs = append(errs, FieldError{Field: "match.route_pattern", Reason: fmt.Sprintf("invalid regular expression: %v", err)})
				} else {
					prog, err := syntax.Compile(re)
					if err != nil {
						errs = append(errs, FieldError{Field: "match.route_pattern", Reason: fmt.Sprintf("failed to compile regular expression: %v", err)})
					} else if len(prog.Inst) > MaxRegexProgLen {
						errs = append(errs, FieldError{Field: "match.route_pattern", Reason: fmt.Sprintf("regular expression complexity (%d instructions) exceeds safety budget %d", len(prog.Inst), MaxRegexProgLen)})
					}
				}
			}
		}
	}

	return errs
}

// canonicalPolicyWire formats Policy with strict deterministic field ordering.
type canonicalPolicyWire struct {
	Algorithm         string            `json:"algorithm"`
	Burst             int64             `json:"burst"`
	CostSpec          canonicalCost     `json:"cost_spec"`
	Enabled           bool              `json:"enabled"`
	FailMode          string            `json:"fail_mode,omitempty"`
	ID                string            `json:"id"`
	Labels            map[string]string `json:"labels,omitempty"`
	Limit             int64             `json:"limit"`
	Match             canonicalMatch    `json:"match"`
	Name              string            `json:"name"`
	OnMissingIdentity string            `json:"on_missing_identity,omitempty"`
	OnReject          canonicalOnReject `json:"on_reject"`
	Priority          int               `json:"priority"`
	Scope             string            `json:"scope"`
	Tenant            string            `json:"tenant"`
	Version           int64             `json:"version"`
	WindowNs          int64             `json:"window_ns"`
}

type canonicalMatch struct {
	Env          string   `json:"env,omitempty"`
	Group        string   `json:"group,omitempty"`
	Methods      []string `json:"methods,omitempty"`
	RoutePattern string   `json:"route_pattern,omitempty"`
}

type canonicalCost struct {
	DefaultCost int64  `json:"default_cost,omitempty"`
	HeaderKey   string `json:"header_key,omitempty"`
	MaxCost     int64  `json:"max_cost,omitempty"`
	Mode        string `json:"mode,omitempty"`
	StaticCost  int64  `json:"static_cost,omitempty"`
}

type canonicalOnReject struct {
	BodyTemplateID string `json:"body_template_id,omitempty"`
	RetryAfterMode string `json:"retry_after_mode,omitempty"`
	Status         int    `json:"status,omitempty"`
}

// CanonicalJSON renders the policy into canonical byte-exact JSON without whitespace variances.
func (p Policy) CanonicalJSON() ([]byte, error) {
	methods := make([]string, len(p.Match.Methods))
	copy(methods, p.Match.Methods)
	sort.Strings(methods)

	wire := canonicalPolicyWire{
		Algorithm: string(p.Algorithm),
		Burst:     p.Burst,
		CostSpec: canonicalCost{
			DefaultCost: p.CostSpec.DefaultCost,
			HeaderKey:   p.CostSpec.HeaderKey,
			MaxCost:     p.CostSpec.MaxCost,
			Mode:        p.CostSpec.Mode,
			StaticCost:  p.CostSpec.StaticCost,
		},
		Enabled:  p.Enabled,
		FailMode: p.FailMode,
		ID:       p.ID,
		Labels:  p.Labels,
		Limit:   p.Limit,
		Match: canonicalMatch{
			Env:          p.Match.Env,
			Group:        p.Match.Group,
			Methods:      methods,
			RoutePattern: p.Match.RoutePattern,
		},
		Name:              p.Name,
		OnMissingIdentity: string(p.OnMissingIdentity),
		OnReject: canonicalOnReject{
			BodyTemplateID: p.OnReject.BodyTemplateID,
			RetryAfterMode: p.OnReject.RetryAfterMode,
			Status:         p.OnReject.Status,
		},
		Priority: p.Priority,
		Scope:    string(p.Scope),
		Tenant:   p.Tenant,
		Version:  p.Version,
		WindowNs: p.Window.Nanoseconds(),
	}

	buf := &bytes.Buffer{}
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(wire); err != nil {
		return nil, errors.Wrap(errors.ErrCodeInternal, "failed to serialize canonical json", err)
	}

	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// ContentHash returns the SHA-256 hex digest of the canonical JSON representation.
func (p Policy) ContentHash() (string, error) {
	data, err := p.CanonicalJSON()
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]), nil
}
