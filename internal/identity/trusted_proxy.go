package identity

import (
	"net/netip"
)

// TrustedProxyChecker determines whether an upstream hop is authorized to set client IP headers.
type TrustedProxyChecker interface {
	IsTrusted(addr netip.Addr) bool
}

// UntrustedProxyChecker is the secure default implementation that trusts nobody and ignores X-Forwarded-For.
type UntrustedProxyChecker struct{}

// NewUntrustedProxyChecker creates an UntrustedProxyChecker.
func NewUntrustedProxyChecker() *UntrustedProxyChecker {
	return &UntrustedProxyChecker{}
}

// IsTrusted always returns false under the zero-trust default posture.
func (u *UntrustedProxyChecker) IsTrusted(_ netip.Addr) bool {
	return false
}
