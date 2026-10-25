package policy

import (
	"encoding/binary"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/errors"
)

// RequestIdentity models inbound caller identity dimensions for policy resolution.
type RequestIdentity struct {
	Tenant     string
	ClientID   string
	APIKeyID   string
	UserID     string
	IP         string
	Route      string
	Method     string
	Group      string
	Attributes map[string]string
}

// RouteRequest models inbound request routing parameters.
type RouteRequest struct {
	Method  string
	Path    string
	Host    string
	Headers map[string]string
}

// ResolvedPolicy represents an actionable policy match with prebuilt storage keys and cost.
type ResolvedPolicy struct {
	Policy     Policy
	KeyBuf     [128]byte
	BinaryKey  []byte
	Cost       int64
	Params     [4]RouteParam
	ParamCount int
	Skip       bool
	Deny       bool
}

// ExtractedParams returns the slice of extracted route parameters.
func (r *ResolvedPolicy) ExtractedParams() []RouteParam {
	return r.Params[:r.ParamCount]
}

// RedisKey renders the canonical Redis cluster hash-tagged key on demand.
func (r *ResolvedPolicy) RedisKey() string {
	var b strings.Builder
	b.Grow(64)
	b.WriteString("rl:{")
	b.WriteString(r.Policy.Tenant)
	b.WriteByte(':')
	b.WriteString(string(r.Policy.Scope))
	b.WriteString("}:")
	b.WriteString(r.Policy.ID)
	b.WriteByte(':')
	b.WriteString(string(r.Policy.Algorithm))
	return b.String()
}

// PolicySnapshot is an immutable compiled view of all active policies, routes, and inheritance hierarchies.
type PolicySnapshot struct {
	Env               string
	Version           int64
	CompiledAt        time.Time
	GlobalTree        *RadixTree
	TenantTrees       map[string]*RadixTree
	EffectivePolicies map[string]*EffectivePolicy
}

// CompileSnapshot builds an immutable, indexed PolicySnapshot from policies, overrides, and environment settings.
func CompileSnapshot(env string, version int64, policies []Policy, overrides []OverrideRecord, clk clock.Clock) (*PolicySnapshot, error) {
	snap := &PolicySnapshot{
		Env:               strings.ToLower(strings.TrimSpace(env)),
		Version:           version,
		CompiledAt:        clk.Now(),
		GlobalTree:        NewRadixTree(),
		TenantTrees:       make(map[string]*RadixTree),
		EffectivePolicies: make(map[string]*EffectivePolicy),
	}

	// Index active overrides by policy ID
	activeOverrides := make(map[string]OverrideRecord)
	for _, ov := range overrides {
		if IsOverrideActive(ov, clk) {
			activeOverrides[ov.PolicyID] = ov
		}
	}

	for _, p := range policies {
		if !p.Enabled {
			continue
		}
		// F57 Environment filtering: if Match.Env is non-empty, must match snapshot Env
		if p.Match.Env != "" && snap.Env != "" && !strings.EqualFold(p.Match.Env, snap.Env) {
			continue
		}

		// Apply temporary override if active
		if ov, ok := activeOverrides[p.ID]; ok {
			p, _ = ApplyActiveOverride(p, ov, clk)
		}

		// Store in radix tree
		tenantKey := strings.TrimSpace(strings.ToLower(p.Tenant))
		var tree *RadixTree
		if tenantKey == "" || tenantKey == "global" || tenantKey == "*" {
			tree = snap.GlobalTree
		} else {
			tree = snap.TenantTrees[tenantKey]
			if tree == nil {
				tree = NewRadixTree()
				snap.TenantTrees[tenantKey] = tree
			}
		}

		routePat := p.Match.RoutePattern
		if routePat == "" {
			routePat = "/**"
		}

		tree.Insert(routePat, p.Match.Methods, "", p)

		snap.EffectivePolicies[p.ID] = &EffectivePolicy{
			Policy: p,
			Provenance: map[string]string{
				FieldAlgorithm: "snapshot:" + p.ID,
				FieldLimit:     "snapshot:" + p.ID,
			},
		}
	}

	return snap, nil
}

func cleanTenantFast(s string) string {
	start := 0
	end := len(s)
	for start < end && s[start] <= ' ' {
		start++
	}
	for end > start && s[end-1] <= ' ' {
		end--
	}
	trimmed := s[start:end]
	for i := 0; i < len(trimmed); i++ {
		if trimmed[i] >= 'A' && trimmed[i] <= 'Z' {
			return strings.ToLower(trimmed)
		}
	}
	return trimmed
}

// Resolve identifies all active policies matching the request, ordered by strict priority,
// with storage keys pre-generated in <= 1 µs and <= 1 alloc.
func (s *PolicySnapshot) Resolve(req RouteRequest, id RequestIdentity) ([]ResolvedPolicy, error) {
	// Stack buffer for initial matched routes: 0 heap allocations
	var matchedBuf [16]MatchedRoute
	matched := matchedBuf[:0]

	// 1. Match tenant-specific tree
	tenantKey := cleanTenantFast(id.Tenant)
	if tenantKey != "" {
		if tree, ok := s.TenantTrees[tenantKey]; ok {
			matched = tree.MatchInto(req.Method, req.Path, req.Host, matched)
		}
	}

	// 2. Match global tree if non-empty
	if s.GlobalTree != nil && s.GlobalTree.root != nil {
		r := s.GlobalTree.root
		if len(r.literalMap) > 0 || len(r.policies) > 0 || r.paramChild != nil || r.wildChild != nil || r.multiChild != nil || len(r.suffixChild) > 0 {
			matched = s.GlobalTree.MatchInto(req.Method, req.Path, req.Host, matched)
		}
	}

	if len(matched) == 0 {
		return nil, nil
	}

	// 3. Strict total priority sort (F55)
	if len(matched) > 1 {
		SortMatchedRoutes(matched)
	}

	// 4. Build precomputed ResolvedPolicy list: exactly 1 slice allocation
	results := make([]ResolvedPolicy, len(matched))

	for i := range matched {
		m := &matched[i]
		pol := m.Policy

		// Extract dimension for scope
		dim, skip, deny, err := extractScopeDimension(id, pol)
		if err != nil {
			if deny {
				results[i] = ResolvedPolicy{
					Policy: pol,
					Deny:   true,
				}
				continue
			}
			return nil, err
		}
		if skip {
			results[i] = ResolvedPolicy{
				Policy: pol,
				Skip:   true,
			}
			continue
		}

		cost := resolveRequestCost(pol.CostSpec, req.Headers)

		res := &results[i]
		res.Policy = pol
		res.Cost = cost
		res.Params = m.Params
		res.ParamCount = m.ParamCount

		// Zero-alloc binary key construction into inline res.KeyBuf
		keyLen := encodeBinaryKey(res.KeyBuf[:0], pol.Tenant, string(pol.Scope), dim, pol.ID, req.Method, pol.Version, id.Attributes)
		res.BinaryKey = res.KeyBuf[:keyLen]
	}

	return results, nil
}

func extractScopeDimension(id RequestIdentity, p Policy) (string, bool, bool, error) {
	var dim string
	var missingField string

	switch p.Scope {
	case ScopeGlobal:
		return "global", false, false, nil
	case ScopeClient:
		dim = id.ClientID
		missingField = "client_id"
	case ScopeUser:
		dim = id.UserID
		missingField = "user_id"
	case ScopeIP:
		dim = id.IP
		missingField = "ip"
	case ScopeRoute:
		if id.Route != "" {
			dim = id.Route
		} else {
			dim = p.Match.RoutePattern
		}
		missingField = "route"
	case ScopeTenant:
		dim = id.Tenant
		missingField = "tenant"
	case ScopeEndpointGroup:
		dim = id.Group
		missingField = "group"
	case ScopeMethod:
		dim = id.Method
		missingField = "method"
	default:
		return "", false, false, errors.New(errors.ErrCodeUnknownScope, fmt.Sprintf("unknown scope %q", p.Scope))
	}

	if dim != "" {
		return dim, false, false, nil
	}

	switch p.OnMissingIdentity {
	case OnMissingSkip:
		return "", true, false, nil
	case OnMissingDeny:
		return "", false, true, errors.New(errors.ErrCodeMissingDimension, fmt.Sprintf("missing required dimension %s for policy %s", missingField, p.ID))
	case OnMissingFallbackIP:
		if id.IP != "" {
			return "ip:" + id.IP, false, false, nil
		}
		return "", false, true, errors.New(errors.ErrCodeMissingDimension, fmt.Sprintf("missing %s and fallback IP empty for policy %s", missingField, p.ID))
	default:
		return "", false, true, errors.New(errors.ErrCodeMissingDimension, fmt.Sprintf("missing required dimension %s for policy %s", missingField, p.ID))
	}
}

func encodeBinaryKey(buf []byte, tenant, scope, dimension, policyID, method string, version int64, attrs map[string]string) int {
	out := buf[:0]
	out = append(out, 0x01) // wire version

	appendField := func(s string) {
		l := uint16(len(s))
		out = append(out, byte(l>>8), byte(l))
		out = append(out, s...)
	}

	appendField(tenant)
	appendField(scope)
	appendField(dimension)
	appendField(policyID)
	appendField(method)

	// int64 version
	var vBytes [8]byte
	binary.BigEndian.PutUint64(vBytes[:], uint64(version))
	out = append(out, vBytes[:]...)

	// attributes
	if len(attrs) == 0 {
		out = append(out, 0, 0)
	} else {
		keys := make([]string, 0, len(attrs))
		for k := range attrs {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		out = append(out, byte(len(keys)>>8), byte(len(keys)))
		for _, k := range keys {
			appendField(k)
			appendField(attrs[k])
		}
	}

	return len(out)
}

func resolveRequestCost(spec CostSpec, headers map[string]string) int64 {
	cost := spec.DefaultCost
	if cost <= 0 {
		cost = 1
	}

	if spec.Mode == "static" && spec.StaticCost > 0 {
		return spec.StaticCost
	}

	if spec.Mode == "header" && spec.HeaderKey != "" && headers != nil {
		if val, ok := headers[spec.HeaderKey]; ok {
			if parsed, err := strconv.ParseInt(strings.TrimSpace(val), 10, 64); err == nil && parsed > 0 {
				cost = parsed
			}
		}
	}

	if spec.MaxCost > 0 && cost > spec.MaxCost {
		cost = spec.MaxCost
	}

	return cost
}
