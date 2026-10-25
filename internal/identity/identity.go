package identity

import (
	"net/netip"

	"rlgw/internal/policy"
)

// Identity represents the resolved client identity context for an ingress HTTP request.
// Designed for zero-allocation reuse on the hot path via Reset().
type Identity struct {
	Tenant     string
	ClientID   string
	APIKeyID   string
	UserID     string
	IP         netip.Addr
	Route      string // Route template (e.g. "/users/{id}"), never raw path
	Method     string
	Group      string
	Attributes map[string]string
	Source     string // Audit source (e.g. "api_key", "jwt", "mtls", "ip_fallback")
}

// Reset clears all fields so the struct can be reused from a sync.Pool or caller stack frame
// with zero heap allocations on the hot path.
func (id *Identity) Reset() {
	id.Tenant = ""
	id.ClientID = ""
	id.APIKeyID = ""
	id.UserID = ""
	id.IP = netip.Addr{}
	id.Route = ""
	id.Method = ""
	id.Group = ""
	id.Source = ""
	if id.Attributes != nil {
		for k := range id.Attributes {
			delete(id.Attributes, k)
		}
	}
}

// ToRequestIdentity converts Identity into a policy.RequestIdentity for Snapshot.Resolve.
func (id *Identity) ToRequestIdentity() policy.RequestIdentity {
	ipStr := ""
	if id.IP.IsValid() {
		ipStr = id.IP.String()
	}
	return policy.RequestIdentity{
		Tenant:     id.Tenant,
		ClientID:   id.ClientID,
		APIKeyID:   id.APIKeyID,
		UserID:     id.UserID,
		IP:         ipStr,
		Route:      id.Route,
		Method:     id.Method,
		Group:      id.Group,
		Attributes: id.Attributes,
	}
}
