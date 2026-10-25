package gateway

import (
	"path"
	"strings"
	"unicode/utf8"

	"rlgw/internal/errors"
)

// TrailingSlashPolicy defines the canonicalization rule for trailing slashes.
type TrailingSlashPolicy string

const (
	TrailingSlashStrip    TrailingSlashPolicy = "strip"
	TrailingSlashAppend   TrailingSlashPolicy = "append"
	TrailingSlashPreserve TrailingSlashPolicy = "preserve"
)

// NormalizerConfig configures route normalization behavior.
type NormalizerConfig struct {
	TrailingSlash   TrailingSlashPolicy `json:"trailing_slash" yaml:"trailing_slash"`     // "strip", "append", "preserve"
	CaseSensitive   bool                `json:"case_sensitive" yaml:"case_sensitive"`     // false = lowercase for matching
	PreserveRawPath bool                `json:"preserve_raw_path" yaml:"preserve_raw_path"` // whether to forward raw path
}

// DefaultNormalizerConfig provides standard secure defaults.
func DefaultNormalizerConfig() NormalizerConfig {
	return NormalizerConfig{
		TrailingSlash:   TrailingSlashStrip,
		CaseSensitive:   false,
		PreserveRawPath: true,
	}
}

// Normalizer normalizes request paths to one canonical form to prevent rate limit bypass.
type Normalizer struct {
	cfg NormalizerConfig
}

// NewNormalizer constructs a Normalizer.
func NewNormalizer(cfg NormalizerConfig) *Normalizer {
	if cfg.TrailingSlash == "" {
		cfg.TrailingSlash = TrailingSlashStrip
	}
	return &Normalizer{cfg: cfg}
}

// isUnreserved reports whether b is an unreserved URL character according to RFC 3986 (section 2.3):
// ALPHA / DIGIT / "-" / "." / "_" / "~"
func isUnreserved(b byte) bool {
	return (b >= 'a' && b <= 'z') ||
		(b >= 'A' && b <= 'Z') ||
		(b >= '0' && b <= '9') ||
		b == '-' || b == '.' || b == '_' || b == '~'
}

// hexVal converts a hex byte to its numeric value (0-15), or -1 if invalid.
func hexVal(b byte) int {
	switch {
	case b >= '0' && b <= '9':
		return int(b - '0')
	case b >= 'a' && b <= 'f':
		return int(b-'a') + 10
	case b >= 'A' && b <= 'F':
		return int(b-'A') + 10
	default:
		return -1
	}
}

// Normalize transforms rawPath into its single canonical form.
// Rejects NUL bytes and invalid UTF-8 with an ErrCodeBadRequest error.
func (n *Normalizer) Normalize(rawPath string) (string, error) {
	if rawPath == "" {
		rawPath = "/"
	}

	// 1. Check for literal NUL byte
	if strings.IndexByte(rawPath, 0) != -1 {
		return "", errors.New(errors.ErrCodeBadRequest, "path contains literal NUL character")
	}

	// 2. Percent-decode unreserved characters ONLY; reject %00
	var decoded strings.Builder
	decoded.Grow(len(rawPath))

	for i := 0; i < len(rawPath); {
		if rawPath[i] == '%' {
			if i+2 < len(rawPath) {
				h1 := hexVal(rawPath[i+1])
				h2 := hexVal(rawPath[i+2])
				if h1 >= 0 && h2 >= 0 {
					decodedByte := byte((h1 << 4) | h2)
					if decodedByte == 0 {
						return "", errors.New(errors.ErrCodeBadRequest, "path contains encoded NUL byte (%00)")
					}
					if isUnreserved(decodedByte) {
						decoded.WriteByte(decodedByte)
						i += 3
						continue
					}
					// Keep reserved character percent-encoded (uppercase hex for consistency)
					decoded.WriteByte('%')
					decoded.WriteByte(strings.ToUpper(string(rawPath[i+1]))[0])
					decoded.WriteByte(strings.ToUpper(string(rawPath[i+2]))[0])
					i += 3
					continue
				}
			}
			return "", errors.New(errors.ErrCodeBadRequest, "malformed percent-encoded sequence in path")
		}
		decoded.WriteByte(rawPath[i])
		i++
	}

	cleanedStr := decoded.String()

	// 3. UTF-8 validity audit
	if !utf8.ValidString(cleanedStr) {
		return "", errors.New(errors.ErrCodeBadRequest, "path contains invalid UTF-8 sequences")
	}

	// 4. Dot segment resolution and slash collapsing
	// path.Clean collapses duplicate slashes and resolves . and ..
	hasTrailing := strings.HasSuffix(cleanedStr, "/") && len(cleanedStr) > 1
	canonical := path.Clean(cleanedStr)

	// Ensure leading slash
	if !strings.HasPrefix(canonical, "/") {
		canonical = "/" + canonical
	}

	// 5. Trailing slash policy
	switch n.cfg.TrailingSlash {
	case TrailingSlashStrip:
		if len(canonical) > 1 && strings.HasSuffix(canonical, "/") {
			canonical = strings.TrimRight(canonical, "/")
		}
	case TrailingSlashAppend:
		if !strings.HasSuffix(canonical, "/") {
			canonical = canonical + "/"
		}
	case TrailingSlashPreserve:
		if hasTrailing && !strings.HasSuffix(canonical, "/") {
			canonical = canonical + "/"
		}
	}

	// 6. Case policy
	if !n.cfg.CaseSensitive {
		canonical = strings.ToLower(canonical)
	}

	return canonical, nil
}

// PreserveRawPath returns whether the raw inbound path should be forwarded upstream.
func (n *Normalizer) PreserveRawPath() bool {
	return n.cfg.PreserveRawPath
}
