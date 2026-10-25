package gateway

import (
	"testing"
)

func TestNormalizerValidations(t *testing.T) {
	norm := NewNormalizer(DefaultNormalizerConfig())

	tests := []struct {
		name        string
		input       string
		expected    string
		expectError bool
	}{
		{
			name:     "simple clean path",
			input:    "/api/v1/users",
			expected: "/api/v1/users",
		},
		{
			name:     "duplicate slashes",
			input:    "//api///v1//users//",
			expected: "/api/v1/users",
		},
		{
			name:     "dot segments",
			input:    "/api/v1/../v2/./users",
			expected: "/api/v2/users",
		},
		{
			name:     "parent traversal attempt beyond root",
			input:    "/../../api/v1/users",
			expected: "/api/v1/users",
		},
		{
			name:     "unreserved percent decoding",
			input:    "/%41%70%69/%761/%7euser", // /Api/v1/~user -> lowercase /api/v1/~user
			expected: "/api/v1/~user",
		},
		{
			name:     "dot percent decoded and resolved",
			input:    "/api/v1/%2e%2e/v2/users", // %2e is '.' so resolves ..
			expected: "/api/v2/users",
		},
		{
			name:     "reserved percent encoding kept",
			input:    "/api/v1/%2Fusers", // %2F is slash, remains encoded
			expected: "/api/v1/%2fusers",
		},
		{
			name:     "case normalization to lower",
			input:    "/API/V1/Users",
			expected: "/api/v1/users",
		},
		{
			name:        "reject literal NUL byte",
			input:       "/api/v1/users\x00admin",
			expectError: true,
		},
		{
			name:        "reject percent encoded NUL byte",
			input:       "/api/v1/users%00admin",
			expectError: true,
		},
		{
			name:        "reject malformed percent encoding",
			input:       "/api/v1/users%2",
			expectError: true,
		},
		{
			name:        "reject invalid UTF-8 sequence",
			input:       "/api/v1/\xff\xfeusers",
			expectError: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := norm.Normalize(tc.input)
			if tc.expectError {
				if err == nil {
					t.Fatalf("expected error for input %q, got nil (result: %q)", tc.input, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error for input %q: %v", tc.input, err)
			}
			if got != tc.expected {
				t.Errorf("Normalize(%q) = %q, expected %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestNormalizerTrailingSlashPolicies(t *testing.T) {
	// 1. Strip policy
	normStrip := NewNormalizer(NormalizerConfig{TrailingSlash: TrailingSlashStrip, CaseSensitive: true})
	got, _ := normStrip.Normalize("/api/v1/users/")
	if got != "/api/v1/users" {
		t.Errorf("expected stripped trailing slash, got %q", got)
	}
	gotRoot, _ := normStrip.Normalize("/")
	if gotRoot != "/" {
		t.Errorf("root should remain /, got %q", gotRoot)
	}

	// 2. Append policy
	normAppend := NewNormalizer(NormalizerConfig{TrailingSlash: TrailingSlashAppend, CaseSensitive: true})
	got, _ = normAppend.Normalize("/api/v1/users")
	if got != "/api/v1/users/" {
		t.Errorf("expected appended trailing slash, got %q", got)
	}

	// 3. Preserve policy
	normPreserve := NewNormalizer(NormalizerConfig{TrailingSlash: TrailingSlashPreserve, CaseSensitive: true})
	gotWith, _ := normPreserve.Normalize("/api/v1/users/")
	if gotWith != "/api/v1/users/" {
		t.Errorf("expected preserved trailing slash, got %q", gotWith)
	}
	gotWithout, _ := normPreserve.Normalize("/api/v1/users")
	if gotWithout != "/api/v1/users" {
		t.Errorf("expected preserved lack of trailing slash, got %q", gotWithout)
	}
}

func TestNormalizerPropertyEquivalence(t *testing.T) {
	norm := NewNormalizer(DefaultNormalizerConfig())

	// All equivalent variations must produce the exact same canonical path: prevents bypass attacks
	variants := []string{
		"/api/v1/users",
		"/api/v1/users/",
		"/API/V1/USERS",
		"//api///v1//users",
		"/api/./v1/users",
		"/api/v2/../v1/users",
		"/%61%70%69/%761/%75%73%65%72%73",
		"/api/v1/%2e%2e/v1/users",
	}

	canonical := "/api/v1/users"
	for _, v := range variants {
		got, err := norm.Normalize(v)
		if err != nil {
			t.Fatalf("unexpected error normalizing %q: %v", v, err)
		}
		if got != canonical {
			t.Errorf("variant %q normalized to %q, expected canonical %q", v, got, canonical)
		}
	}
}
