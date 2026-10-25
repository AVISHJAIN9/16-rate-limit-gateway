package policy

import (
	"testing"
	"time"

	"rlgw/internal/errors"
)

func TestPolicyTemplateExpansionAndValidation(t *testing.T) {
	tmpl := TemplateRecord{
		ID:      "tmpl-service-tier",
		Tenant:  "tenant-core",
		Name:    "Service Tier Blueprint",
		Version: 1,
		Parameters: []TemplateParam{
			{Name: "limit", Type: "int", Required: true},
			{Name: "burst", Type: "int", Required: true},
			{Name: "window", Type: "duration", Required: false, Default: "1m"},
			{Name: "tenant", Type: "string", Required: true},
		},
		Body: `{
			"id": "pol-{{tenant}}-tier",
			"name": "{{tenant}} Rate Limit",
			"tenant": "{{tenant}}",
			"algorithm": "token_bucket",
			"scope": "client",
			"limit": {{limit}},
			"burst": {{burst}},
			"window": "{{window}}",
			"enabled": true
		}`,
	}

	// 1. Successful instantiation
	params := map[string]string{
		"limit":  "500",
		"burst":  "600",
		"tenant": "tenant-core",
	}

	p, err := InstantiateTemplate(tmpl, params)
	if err != nil {
		t.Fatalf("InstantiateTemplate failed: %v", err)
	}

	if p.ID != "pol-tenant-core-tier" {
		t.Fatalf("expected ID 'pol-tenant-core-tier', got %q", p.ID)
	}
	if p.Limit != 500 || p.Burst != 600 {
		t.Fatalf("expected 500/600 limit/burst, got %d/%d", p.Limit, p.Burst)
	}
	if p.Window != time.Minute {
		t.Fatalf("expected default window 1m, got %v", p.Window)
	}

	// 2. Missing required parameter (limit)
	_, err = InstantiateTemplate(tmpl, map[string]string{"burst": "600", "tenant": "tenant-core"})
	if err == nil || !errors.IsCode(err, errors.ErrCodeTemplateInvalid) {
		t.Fatalf("expected ErrCodeTemplateInvalid on missing required param, got: %v", err)
	}

	// 3. Invalid typed parameter (non-integer limit)
	_, err = InstantiateTemplate(tmpl, map[string]string{"limit": "not-a-number", "burst": "600", "tenant": "tenant-core"})
	if err == nil || !errors.IsCode(err, errors.ErrCodeTemplateInvalid) {
		t.Fatalf("expected ErrCodeTemplateInvalid on invalid int param, got: %v", err)
	}

	// 4. Invalid duration
	_, err = InstantiateTemplate(tmpl, map[string]string{"limit": "100", "burst": "100", "tenant": "tenant-core", "window": "invalid-duration"})
	if err == nil || !errors.IsCode(err, errors.ErrCodeTemplateInvalid) {
		t.Fatalf("expected ErrCodeTemplateInvalid on invalid duration param, got: %v", err)
	}

	// 5. Hostile injection inputs: code execution / JSON breakout attempt
	hostileParams := map[string]string{
		"limit":  "100",
		"burst":  "100",
		"tenant": `tenant", "limit": 999999, "__injected": "true`,
	}
	// Template expansion parses strictly as JSON and validates against Policy schema
	_, err = InstantiateTemplate(tmpl, hostileParams)
	// Must fail parsing or fail validation
	if err == nil {
		t.Fatalf("expected hostile JSON breakout input to be rejected")
	}
}
