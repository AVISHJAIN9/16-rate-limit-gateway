package gateway

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTemplatesContentNegotiation(t *testing.T) {
	registry := NewTemplateRegistry()
	vars := TemplateVariables{
		RetryAfter: 5,
		Limit:      100,
		Remaining:  0,
		Reset:      10,
		Policy:     "pol-search",
		RequestID:  "req-abc-123",
		ClientID:   "client-42",
		Tenant:     "acme",
	}

	// 1. Problem JSON negotiation
	body, ctype := registry.RenderNegotiated("", "application/problem+json, application/json", vars)
	if !strings.Contains(ctype, "application/problem+json") {
		t.Errorf("expected application/problem+json, got %q", ctype)
	}
	var prob map[string]any
	if err := json.Unmarshal(body, &prob); err != nil {
		t.Fatalf("problem+json is not valid JSON: %v", err)
	}
	if prob["title"] != "Too Many Requests" || prob["status"] != float64(429) {
		t.Errorf("unexpected problem json fields: %+v", prob)
	}

	// 2. HTML negotiation
	bodyHTML, ctypeHTML := registry.RenderNegotiated("", "text/html, application/xhtml+xml", vars)
	if !strings.Contains(ctypeHTML, "text/html") {
		t.Errorf("expected text/html, got %q", ctypeHTML)
	}
	if !strings.Contains(string(bodyHTML), "<h1>429 Too Many Requests</h1>") {
		t.Errorf("expected HTML header in body, got %s", string(bodyHTML))
	}

	// 3. Text negotiation
	bodyText, ctypeText := registry.RenderNegotiated("", "text/plain", vars)
	if !strings.Contains(ctypeText, "text/plain") {
		t.Errorf("expected text/plain, got %q", ctypeText)
	}
	if !strings.Contains(string(bodyText), "Too Many Requests: Rate limit exceeded") {
		t.Errorf("expected text body, got %s", string(bodyText))
	}

	// 4. Default JSON negotiation
	bodyDefault, ctypeDefault := registry.RenderNegotiated("", "*/*", vars)
	if !strings.Contains(ctypeDefault, "application/json") {
		t.Errorf("expected application/json, got %q", ctypeDefault)
	}
	var def map[string]any
	if err := json.Unmarshal(bodyDefault, &def); err != nil {
		t.Fatalf("default json is not valid JSON: %v", err)
	}
	if def["error"] != "too_many_requests" {
		t.Errorf("unexpected json: %+v", def)
	}
}

func TestTemplatesSafeEscaping(t *testing.T) {
	registry := NewTemplateRegistry()

	// Hostile input with quotes and script tags
	hostileVars := TemplateVariables{
		RetryAfter: 3,
		Limit:      50,
		Policy:     `pol-"malicious\`,
		RequestID:  `<script>alert("pwned")</script>`,
	}

	// JSON escaping audit
	bodyJSON, _ := registry.RenderNegotiated("", "application/json", hostileVars)
	var parsed map[string]any
	if err := json.Unmarshal(bodyJSON, &parsed); err != nil {
		t.Fatalf("JSON injection broke template JSON validity! %v, body: %s", err, string(bodyJSON))
	}
	if parsed["policy"] != `pol-"malicious\` {
		t.Errorf("unexpected policy unmarshaled: %v", parsed["policy"])
	}

	// HTML escaping audit
	bodyHTML, _ := registry.RenderNegotiated("", "text/html", hostileVars)
	if strings.Contains(string(bodyHTML), "<script>") {
		t.Fatalf("HTML injection vulnerability found! Raw script tag present in HTML body: %s", string(bodyHTML))
	}
	if !strings.Contains(string(bodyHTML), "&lt;script&gt;") {
		t.Errorf("expected HTML escaped tag, got: %s", string(bodyHTML))
	}
}
