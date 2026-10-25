package identity

import (
	"fmt"
	"strings"

	"rlgw/internal/errors"
	"rlgw/internal/policy"
)

// ScopeResolutionResult encapsulates the extracted dimension and missing-dimension policy directive.
type ScopeResolutionResult struct {
	Dimension string
	Skip      bool
	Deny      bool
}

// ScopeKeyer extracts the rate limiting partition dimension from Identity.
type ScopeKeyer interface {
	ExtractDimension(id *Identity, p *policy.Policy) (ScopeResolutionResult, error)
}

// GlobalScopeKeyer produces a single shared counter across all identities for policy F9.
type GlobalScopeKeyer struct{}

func (k GlobalScopeKeyer) ExtractDimension(_ *Identity, _ *policy.Policy) (ScopeResolutionResult, error) {
	return ScopeResolutionResult{Dimension: "global"}, nil
}

// ClientScopeKeyer keys by ClientID for F10.
type ClientScopeKeyer struct{}

func (k ClientScopeKeyer) ExtractDimension(id *Identity, p *policy.Policy) (ScopeResolutionResult, error) {
	if id.ClientID != "" {
		return ScopeResolutionResult{Dimension: id.ClientID}, nil
	}
	return handleMissingDimension(id, p, "client_id")
}

// UserScopeKeyer keys by UserID for F11 & F5.
type UserScopeKeyer struct{}

func (k UserScopeKeyer) ExtractDimension(id *Identity, p *policy.Policy) (ScopeResolutionResult, error) {
	if id.UserID != "" {
		return ScopeResolutionResult{Dimension: id.UserID}, nil
	}
	return handleMissingDimension(id, p, "user_id")
}

// IPScopeKeyer keys by normalized IP for F12 & F6.
type IPScopeKeyer struct{}

func (k IPScopeKeyer) ExtractDimension(id *Identity, p *policy.Policy) (ScopeResolutionResult, error) {
	if id.IP.IsValid() {
		return ScopeResolutionResult{Dimension: id.IP.String()}, nil
	}
	return handleMissingDimension(id, p, "ip")
}

// RouteScopeKeyer keys by route template (e.g. "/users/{id}") for F13 & F7.
type RouteScopeKeyer struct{}

func (k RouteScopeKeyer) ExtractDimension(id *Identity, p *policy.Policy) (ScopeResolutionResult, error) {
	if id.Route != "" {
		return ScopeResolutionResult{Dimension: id.Route}, nil
	}
	return handleMissingDimension(id, p, "route")
}

// TenantScopeKeyer keys by Tenant for F14 (tenant aggregate).
type TenantScopeKeyer struct{}

func (k TenantScopeKeyer) ExtractDimension(id *Identity, p *policy.Policy) (ScopeResolutionResult, error) {
	if id.Tenant != "" {
		return ScopeResolutionResult{Dimension: id.Tenant}, nil
	}
	return handleMissingDimension(id, p, "tenant")
}

// EndpointGroupScopeKeyer keys by route group for F15.
type EndpointGroupScopeKeyer struct{}

func (k EndpointGroupScopeKeyer) ExtractDimension(id *Identity, p *policy.Policy) (ScopeResolutionResult, error) {
	if id.Group != "" {
		return ScopeResolutionResult{Dimension: id.Group}, nil
	}
	return handleMissingDimension(id, p, "group")
}

// MethodScopeKeyer keys by HTTP method / method class for F8.
type MethodScopeKeyer struct{}

func (k MethodScopeKeyer) ExtractDimension(id *Identity, p *policy.Policy) (ScopeResolutionResult, error) {
	method := strings.ToUpper(strings.TrimSpace(id.Method))
	if method != "" {
		return ScopeResolutionResult{Dimension: method}, nil
	}
	return handleMissingDimension(id, p, "method")
}

func handleMissingDimension(id *Identity, p *policy.Policy, dimName string) (ScopeResolutionResult, error) {
	switch p.OnMissingIdentity {
	case policy.OnMissingSkip:
		return ScopeResolutionResult{Skip: true}, nil
	case policy.OnMissingDeny:
		return ScopeResolutionResult{Deny: true}, errors.Wrap(errors.ErrCodeMissingDimension, fmt.Sprintf("missing required %s dimension for policy %s", dimName, p.ID), nil)
	case policy.OnMissingFallbackIP:
		if id.IP.IsValid() {
			return ScopeResolutionResult{Dimension: "ip:" + id.IP.String()}, nil
		}
		return ScopeResolutionResult{Deny: true}, errors.Wrap(errors.ErrCodeMissingDimension, fmt.Sprintf("missing %s dimension and fallback IP invalid for policy %s", dimName, p.ID), nil)
	default:
		// Default strict: deny
		return ScopeResolutionResult{Deny: true}, errors.Wrap(errors.ErrCodeMissingDimension, fmt.Sprintf("missing required %s dimension for policy %s", dimName, p.ID), nil)
	}
}

// GetScopeKeyer returns the ScopeKeyer strategy corresponding to scope.
func GetScopeKeyer(scope policy.Scope) (ScopeKeyer, error) {
	switch scope {
	case policy.ScopeGlobal:
		return GlobalScopeKeyer{}, nil
	case policy.ScopeClient:
		return ClientScopeKeyer{}, nil
	case policy.ScopeUser:
		return UserScopeKeyer{}, nil
	case policy.ScopeIP:
		return IPScopeKeyer{}, nil
	case policy.ScopeRoute:
		return RouteScopeKeyer{}, nil
	case policy.ScopeTenant:
		return TenantScopeKeyer{}, nil
	case policy.ScopeEndpointGroup:
		return EndpointGroupScopeKeyer{}, nil
	case policy.ScopeMethod:
		return MethodScopeKeyer{}, nil
	default:
		return nil, errors.Wrap(errors.ErrCodeUnknownScope, fmt.Sprintf("unknown scope %q", scope), nil)
	}
}
