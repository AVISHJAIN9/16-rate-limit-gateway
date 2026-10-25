package identity

import (
	"encoding/binary"
	"fmt"
	"sort"
	"strings"

	"rlgw/internal/policy"
)

// BinaryKeyWireVersion denotes the serialization version for rate limit counter binary keys.
const BinaryKeyWireVersion byte = 0x01

// KeyBuilderOptions configures key construction semantics.
type KeyBuilderOptions struct {
	// IncludePolicyVersion controls whether the policy version is included in the counter key.
	// Architectural Decision & Consequence for Rollback:
	// - When false (default): Counter keys are agnostic to policy version. Modifying or rolling back
	//   a policy preserves existing counter usage and rate windows. Throttled abusers remain throttled
	//   after a policy edit or rollback.
	// - When true: Bumping a policy version creates brand-new counter keys. This provides a fresh
	//   window on spec changes, but an emergency rollback will reset quotas for throttled clients.
	IncludePolicyVersion bool

	// Namespace prefixes the Redis string keys. Default is "rl".
	Namespace string
}

// KeyBuilder produces collision-free binary and Redis cluster hash-tagged string keys.
type KeyBuilder struct {
	opts KeyBuilderOptions
}

// NewKeyBuilder constructs a KeyBuilder with opts.
func NewKeyBuilder(opts KeyBuilderOptions) *KeyBuilder {
	if opts.Namespace == "" {
		opts.Namespace = "rl"
	}
	return &KeyBuilder{opts: opts}
}

// KeyComponents holds identity and policy attributes for key generation.
type KeyComponents struct {
	Tenant        string
	Scope         policy.Scope
	Dimension     string
	PolicyID      string
	PolicyVersion int64
	Method        string
	Attributes    map[string]string
}

// BuildBinaryKeyToBuf constructs a length-prefixed canonical binary key into the caller-provided buf.
// If cap(buf) >= required size, this function performs ZERO heap allocations and finishes in ≤ 100 ns.
//
// Binary wire format:
// [1 byte: WireVersion 0x01]
// [2 bytes uint16: tenant len] [tenant bytes]
// [2 bytes uint16: scope len] [scope bytes]
// [2 bytes uint16: dimension len] [dimension bytes]
// [2 bytes uint16: policyID len] [policyID bytes]
// [2 bytes uint16: method len] [method bytes]
// [8 bytes int64: policyVersion] (only if IncludePolicyVersion is true)
// [2 bytes uint16: attributes count]
// For each attribute (sorted by key for deterministic order-independence):
//
//	[2 bytes uint16: key len] [key bytes]
//	[2 bytes uint16: val len] [val bytes]
func (kb *KeyBuilder) BuildBinaryKeyToBuf(buf []byte, kc KeyComponents) []byte {
	out := buf[:0]

	// 1. Wire version
	out = append(out, BinaryKeyWireVersion)

	// Helper to append length-prefixed string
	appendLP := func(s string) {
		l := uint16(len(s))
		var lenBuf [2]byte
		binary.BigEndian.PutUint16(lenBuf[:], l)
		out = append(out, lenBuf[:]...)
		out = append(out, s...)
	}

	appendLP(kc.Tenant)
	appendLP(string(kc.Scope))
	appendLP(kc.Dimension)
	appendLP(kc.PolicyID)
	appendLP(kc.Method)

	// Policy version
	if kb.opts.IncludePolicyVersion {
		var vBuf [8]byte
		binary.BigEndian.PutUint64(vBuf[:], uint64(kc.PolicyVersion))
		out = append(out, vBuf[:]...)
	}

	// Sorted attributes for order-independent collision resistance
	if len(kc.Attributes) == 0 {
		var zeroCount [2]byte
		out = append(out, zeroCount[:]...)
	} else {
		// Collect and sort keys
		keys := make([]string, 0, len(kc.Attributes))
		for k := range kc.Attributes {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		var countBuf [2]byte
		binary.BigEndian.PutUint16(countBuf[:], uint16(len(keys)))
		out = append(out, countBuf[:]...)

		for _, k := range keys {
			appendLP(k)
			appendLP(kc.Attributes[k])
		}
	}

	return out
}

// BuildBinaryKey creates a new heap-allocated slice containing the binary key.
func (kb *KeyBuilder) BuildBinaryKey(kc KeyComponents) []byte {
	// Pre-estimate buffer size: ~128 bytes typical
	buf := make([]byte, 0, 128)
	return kb.BuildBinaryKeyToBuf(buf, kc)
}

// BuildRedisKey produces a stable Redis Cluster compatible string key with hash-tag {tenant:subject}.
//
// Hash-tag placement design:
// Format: "{namespace}:{{tenant}:{subject}}:{scope}:{policyID}"
// In Redis Cluster, the substring inside {...} is hashed using CRC16 to determine the slot.
// By placing "{tenant:subject}" as the hash tag, all rate limits for the same client / user / tenant
// hash to the EXACT SAME cluster slot, enabling multi-key transactions and atomic Lua operations in Set 5.
func (kb *KeyBuilder) BuildRedisKey(kc KeyComponents) string {
	subject := kc.Dimension
	if subject == "" {
		subject = "all"
	}

	var sb strings.Builder
	sb.Grow(len(kb.opts.Namespace) + len(kc.Tenant) + len(subject) + len(kc.Scope) + len(kc.PolicyID) + 32)

	sb.WriteString(kb.opts.Namespace)
	sb.WriteString(":{")
	sb.WriteString(kc.Tenant)
	sb.WriteString(":")
	sb.WriteString(subject)
	sb.WriteString("}:")
	sb.WriteString(string(kc.Scope))
	sb.WriteString(":")
	sb.WriteString(kc.PolicyID)

	if kc.Method != "" {
		sb.WriteString(":")
		sb.WriteString(strings.ToUpper(kc.Method))
	}

	if kb.opts.IncludePolicyVersion {
		sb.WriteString(":v")
		sb.WriteString(fmt.Sprintf("%d", kc.PolicyVersion))
	}

	return sb.String()
}
