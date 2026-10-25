package policy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rlgw/internal/errors"
)

func TestBundleStrictSchemaUnknownFieldRejection(t *testing.T) {
	// YAML with unknown field "unrecognized_attribute"
	badYAML := `
version: 1
env: prod
unrecognized_attribute: "malicious_payload"
policies:
  - id: "pol-1"
    name: "Standard"
    tenant: "acme"
    algorithm: "token_bucket"
    scope: "client"
    limit: 100
    burst: 100
    window: "1m"
`
	_, err := ParseBundleStrict([]byte(badYAML))
	if err == nil {
		t.Fatalf("expected strict bundle parsing to reject unknown field, got nil")
	}
	if !errors.IsCode(err, errors.ErrCodeConfigInvalid) {
		t.Fatalf("expected ErrCodeConfigInvalid, got: %v", err)
	}
	// Verify error mentions unknown field or line
	if !strings.Contains(err.Error(), "unrecognized_attribute") && !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected error message to identify unknown field: %v", err)
	}
}

func TestBundleIncludesAndCycleDetection(t *testing.T) {
	dir := t.TempDir()

	// 1. Valid includes hierarchy: root -> child.yaml
	childPath := filepath.Join(dir, "child.yaml")
	childYAML := `
version: 1
policies:
  - id: "pol-child"
    name: "Child Policy"
    tenant: "acme"
    algorithm: "token_bucket"
    scope: "client"
    limit: 200
    burst: 200
    window: "10s"
`
	if err := os.WriteFile(childPath, []byte(childYAML), 0o600); err != nil {
		t.Fatalf("failed to write child.yaml: %v", err)
	}

	rootPath := filepath.Join(dir, "root.yaml")
	rootYAML := `
version: 1
env: staging
includes:
  - "child.yaml"
policies:
  - id: "pol-root"
    name: "Root Policy"
    tenant: "acme"
    algorithm: "fixed_window"
    scope: "ip"
    limit: 50
    burst: 50
    window: "1s"
`
	if err := os.WriteFile(rootPath, []byte(rootYAML), 0o600); err != nil {
		t.Fatalf("failed to write root.yaml: %v", err)
	}

	bundle, err := LoadBundleWithIncludes(rootPath, nil)
	if err != nil {
		t.Fatalf("LoadBundleWithIncludes failed: %v", err)
	}
	if len(bundle.Policies) != 2 {
		t.Fatalf("expected 2 merged policies (root + child), got %d", len(bundle.Policies))
	}

	// 2. Circular include test: loop_a -> loop_b -> loop_a
	loopAPath := filepath.Join(dir, "loop_a.yaml")
	loopBPath := filepath.Join(dir, "loop_b.yaml")

	loopAYAML := `
version: 1
includes:
  - "loop_b.yaml"
`
	loopBYAML := `
version: 1
includes:
  - "loop_a.yaml"
`
	_ = os.WriteFile(loopAPath, []byte(loopAYAML), 0o600)
	_ = os.WriteFile(loopBPath, []byte(loopBYAML), 0o600)

	_, err = LoadBundleWithIncludes(loopAPath, nil)
	if err == nil {
		t.Fatalf("expected circular include to return error")
	}
	if !strings.Contains(err.Error(), "circular include") {
		t.Fatalf("expected circular include error, got: %v", err)
	}
}

func TestSecretResolutionAnd12FactorEnv(t *testing.T) {
	// 1. env: secret ref
	t.Setenv("TEST_GATEWAY_SECRET", "super-secret-token-xyz")
	resolvedEnv, err := ResolveSecret("env:TEST_GATEWAY_SECRET")
	if err != nil {
		t.Fatalf("ResolveSecret env failed: %v", err)
	}
	if resolvedEnv != "super-secret-token-xyz" {
		t.Fatalf("unexpected secret value: %s", resolvedEnv)
	}

	// Missing env var
	_, err = ResolveSecret("env:NON_EXISTENT_VAR_12345")
	if err == nil {
		t.Fatalf("expected error for non-existent env var")
	}

	// 2. file: secret ref
	dir := t.TempDir()
	secretFile := filepath.Join(dir, "secret.key")
	if err := os.WriteFile(secretFile, []byte("file-token-content\n"), 0o600); err != nil {
		t.Fatalf("failed to write secret file: %v", err)
	}
	resolvedFile, err := ResolveSecret("file:" + secretFile)
	if err != nil {
		t.Fatalf("ResolveSecret file failed: %v", err)
	}
	if resolvedFile != "file-token-content" {
		t.Fatalf("expected trimmed file content 'file-token-content', got %q", resolvedFile)
	}

	// 3. 12-Factor Env Overrides
	t.Setenv("RLGW_ENV", "staging")
	t.Setenv("RLGW_CONFIG_PATH", "/custom/path/rules.yaml")
	t.Setenv("RLGW_FSYNC", "periodic")

	procCfg := LoadProcessConfig()
	if procCfg.Env != "staging" {
		t.Fatalf("expected env 'staging', got %s", procCfg.Env)
	}
	if procCfg.ConfigPath != "/custom/path/rules.yaml" {
		t.Fatalf("expected config path '/custom/path/rules.yaml', got %s", procCfg.ConfigPath)
	}
	if procCfg.Fsync != FsyncPeriodic {
		t.Fatalf("expected fsync periodic, got %s", procCfg.Fsync)
	}
}

func TestBundlePolicyDurationParsing(t *testing.T) {
	bp := BundlePolicy{
		ID:        "pol-dur",
		Name:      "Duration Policy",
		Tenant:    "acme",
		Algorithm: AlgorithmTokenBucket,
		Scope:     ScopeClient,
		Limit:     100,
		Burst:     100,
		Window:    "2h30m",
	}

	p, err := bp.ToPolicy()
	if err != nil {
		t.Fatalf("ToPolicy failed: %v", err)
	}
	expectedDur := 2*time.Hour + 30*time.Minute
	if p.Window != expectedDur {
		t.Fatalf("expected window %v, got %v", expectedDur, p.Window)
	}
}

func TestExampleBundleFilesParseSuccessfully(t *testing.T) {
	bundle, err := LoadBundleWithIncludes("../../examples/policies.yaml", nil)
	if err != nil {
		t.Fatalf("failed to load examples/policies.yaml: %v", err)
	}

	if len(bundle.Policies) == 0 {
		t.Fatalf("expected policies in examples/policies.yaml, got 0")
	}

	for _, bp := range bundle.Policies {
		p, err := bp.ToPolicy()
		if err != nil {
			t.Fatalf("failed to convert bundle policy %s: %v", bp.ID, err)
		}
		if valErrs := p.Validate(); len(valErrs) > 0 {
			t.Fatalf("policy %s in examples failed validation: %s", p.ID, valErrs.Error())
		}
	}
}

