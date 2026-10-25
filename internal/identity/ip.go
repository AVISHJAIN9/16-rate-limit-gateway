package identity

import (
	"fmt"
	"net/netip"
	"strings"
)

const (
	DefaultIPv6PrefixBits = 64
)

// ParseAndNormalizeIP parses an IP string, strips ports/zones, unwraps IPv4-mapped IPv6 addresses,
// and optionally applies IPv6 prefix masking (e.g. /64) to bound cardinality and resist address rotation.
func ParseAndNormalizeIP(raw string, ipv6PrefixBits int) (netip.Addr, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return netip.Addr{}, fmt.Errorf("empty IP address")
	}

	// Strip potential port (e.g. "192.0.2.1:8080" or "[2001:db8::1]:8080")
	if ap, err := netip.ParseAddrPort(trimmed); err == nil {
		return NormalizeAddr(ap.Addr(), ipv6PrefixBits), nil
	}

	// Strip brackets if provided e.g. "[2001:db8::1]"
	trimmed = strings.TrimPrefix(trimmed, "[")
	trimmed = strings.TrimSuffix(trimmed, "]")

	addr, err := netip.ParseAddr(trimmed)
	if err != nil {
		return netip.Addr{}, fmt.Errorf("malformed IP %q: %w", raw, err)
	}

	return NormalizeAddr(addr, ipv6PrefixBits), nil
}

// NormalizeAddr normalizes netip.Addr:
// 1. Unmaps IPv4-mapped IPv6 (e.g. ::ffff:192.0.2.1 -> 192.0.2.1)
// 2. Applies prefix mask for IPv6 (e.g. /64) if prefixBits > 0 and < 128
func NormalizeAddr(addr netip.Addr, ipv6PrefixBits int) netip.Addr {
	if !addr.IsValid() {
		return addr
	}

	// 1. Unmap IPv4-mapped IPv6
	if addr.Is4In6() {
		addr = addr.Unmap()
	}

	// 2. If IPv4, return as-is
	if addr.Is4() {
		return addr
	}

	// 3. IPv6 prefix aggregation
	if ipv6PrefixBits <= 0 || ipv6PrefixBits >= 128 {
		return addr
	}

	bytes16 := addr.As16()
	fullBytes := ipv6PrefixBits / 8
	remBits := ipv6PrefixBits % 8

	// Mask out remaining bits in the transition byte
	if remBits > 0 && fullBytes < 16 {
		mask := byte(0xFF << (8 - remBits))
		bytes16[fullBytes] &= mask
		fullBytes++
	}

	// Zero out subsequent host bytes
	for i := fullBytes; i < 16; i++ {
		bytes16[i] = 0
	}

	return netip.AddrFrom16(bytes16)
}
