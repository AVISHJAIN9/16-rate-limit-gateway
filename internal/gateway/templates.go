package gateway

import (
	"encoding/json"
	"fmt"
	"html"
	"mime"
	"strconv"
	"strings"

	"rlgw/internal/errors"
)

const MaxTemplateSizeBytes = 65536 // 64 KB

// TemplateVariables contains runtime values injected into rejection templates.
type TemplateVariables struct {
	RetryAfter int64
	Limit      int64
	Remaining  int64
	Reset      int64
	Policy     string
	RequestID  string
	ClientID   string
	Tenant     string
}

// RejectionTemplate represents a validated response template.
type RejectionTemplate struct {
	ID          string `json:"id" yaml:"id"`
	ContentType string `json:"content_type" yaml:"content_type"`
	Body        string `json:"body" yaml:"body"`
}

// Validate audits the template for bounds and basic syntax safety.
func (t *RejectionTemplate) Validate() error {
	if strings.TrimSpace(t.ID) == "" {
		return errors.New(errors.ErrCodeTemplateInvalid, "template id is required")
	}
	if strings.TrimSpace(t.ContentType) == "" {
		return errors.New(errors.ErrCodeTemplateInvalid, "template content_type is required")
	}
	if len(t.Body) > MaxTemplateSizeBytes {
		return errors.New(errors.ErrCodeTemplateInvalid, fmt.Sprintf("template %s exceeds maximum size of %d bytes", t.ID, MaxTemplateSizeBytes))
	}
	return nil
}

// TemplateRegistry caches and renders rejection templates with content negotiation.
type TemplateRegistry struct {
	templates map[string]RejectionTemplate
}

// NewTemplateRegistry creates a TemplateRegistry with standard built-in templates.
func NewTemplateRegistry() *TemplateRegistry {
	r := &TemplateRegistry{
		templates: make(map[string]RejectionTemplate),
	}

	// Register built-in defaults
	r.Register(RejectionTemplate{
		ID:          "default_json",
		ContentType: "application/json",
		Body:        `{"error":"too_many_requests","message":"Rate limit exceeded. Please retry after {{retry_after}} seconds.","limit":{{limit}},"remaining":{{remaining}},"retry_after":{{retry_after}},"policy":"{{policy}}","request_id":"{{request_id}}"}`,
	})
	r.Register(RejectionTemplate{
		ID:          "default_problem_json",
		ContentType: "application/problem+json",
		Body:        `{"type":"https://httpstatuses.com/429","title":"Too Many Requests","status":429,"detail":"Quota exhausted for policy {{policy}}. Retry after {{retry_after}} seconds.","instance":"urn:uuid:{{request_id}}","retry_after":{{retry_after}},"limit":{{limit}},"remaining":{{remaining}}}`,
	})
	r.Register(RejectionTemplate{
		ID:          "default_text",
		ContentType: "text/plain; charset=utf-8",
		Body:        `Too Many Requests: Rate limit exceeded. Retry after {{retry_after}} seconds. (Policy: {{policy}}, Request ID: {{request_id}})`,
	})
	r.Register(RejectionTemplate{
		ID:          "default_html",
		ContentType: "text/html; charset=utf-8",
		Body:        `<!DOCTYPE html><html><head><title>429 Too Many Requests</title></head><body><h1>429 Too Many Requests</h1><p>Rate limit exceeded for policy <strong>{{policy}}</strong>. Please retry in {{retry_after}} seconds.</p><p><small>Request ID: {{request_id}}</small></p></body></html>`,
	})

	return r
}

// Register adds or replaces a template.
func (r *TemplateRegistry) Register(tmpl RejectionTemplate) error {
	if err := tmpl.Validate(); err != nil {
		return err
	}
	r.templates[tmpl.ID] = tmpl
	return nil
}

// Get retrieves a template by ID.
func (r *TemplateRegistry) Get(id string) (RejectionTemplate, bool) {
	t, ok := r.templates[id]
	return t, ok
}

// NegotiateContentType determines the best matching content type based on the Accept header.
func NegotiateContentType(acceptHeader string) string {
	if acceptHeader == "" || acceptHeader == "*/*" {
		return "application/json"
	}

	// Simple fast parse of accept header
	clauses := strings.Split(acceptHeader, ",")
	for _, clause := range clauses {
		mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(clause))
		if err != nil {
			continue
		}
		switch mediaType {
		case "application/problem+json":
			return "application/problem+json"
		case "application/json":
			return "application/json"
		case "text/html", "application/xhtml+xml":
			return "text/html; charset=utf-8"
		case "text/plain":
			return "text/plain; charset=utf-8"
		}
	}

	return "application/json"
}

// RenderTemplate renders the template with variable substitutions and content-aware escaping.
func RenderTemplate(tmpl RejectionTemplate, vars TemplateVariables) ([]byte, string) {
	body := tmpl.Body
	isJSON := strings.Contains(tmpl.ContentType, "json")
	isHTML := strings.Contains(tmpl.ContentType, "html")

	escapeStr := func(val string) string {
		if isJSON {
			b, _ := json.Marshal(val)
			s := string(b)
			if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
				return s[1 : len(s)-1]
			}
			return s
		}
		if isHTML {
			return html.EscapeString(val)
		}
		return val
	}

	replacer := strings.NewReplacer(
		"{{retry_after}}", strconv.FormatInt(vars.RetryAfter, 10),
		"{{limit}}", strconv.FormatInt(vars.Limit, 10),
		"{{remaining}}", strconv.FormatInt(vars.Remaining, 10),
		"{{reset}}", strconv.FormatInt(vars.Reset, 10),
		"{{policy}}", escapeStr(vars.Policy),
		"{{request_id}}", escapeStr(vars.RequestID),
		"{{client_id}}", escapeStr(vars.ClientID),
		"{{tenant}}", escapeStr(vars.Tenant),
	)

	rendered := replacer.Replace(body)
	return []byte(rendered), tmpl.ContentType
}

// RenderNegotiated selects and renders a template based on templateID or Accept header negotiation.
func (r *TemplateRegistry) RenderNegotiated(templateID, acceptHeader string, vars TemplateVariables) ([]byte, string) {
	// 1. If explicit template ID provided and found
	if templateID != "" {
		if tmpl, ok := r.templates[templateID]; ok {
			return RenderTemplate(tmpl, vars)
		}
	}

	// 2. Negotiate based on Accept header
	negotiated := NegotiateContentType(acceptHeader)
	switch {
	case strings.Contains(negotiated, "problem+json"):
		if tmpl, ok := r.templates["default_problem_json"]; ok {
			return RenderTemplate(tmpl, vars)
		}
	case strings.Contains(negotiated, "html"):
		if tmpl, ok := r.templates["default_html"]; ok {
			return RenderTemplate(tmpl, vars)
		}
	case strings.Contains(negotiated, "text/plain"):
		if tmpl, ok := r.templates["default_text"]; ok {
			return RenderTemplate(tmpl, vars)
		}
	}

	// 3. Fallback to default_json
	if tmpl, ok := r.templates["default_json"]; ok {
		return RenderTemplate(tmpl, vars)
	}

	// Hardcoded fallback
	return []byte(`{"error":"too_many_requests","message":"Rate limit exceeded"}`), "application/json"
}
