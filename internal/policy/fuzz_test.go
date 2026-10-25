package policy

import (
	"encoding/json"
	"testing"
)

// FuzzPolicyJSONRoundTrip verifies that arbitrary JSON unmarshaled into Policy
// and re-serialized round-trips without loss or panic.
func FuzzPolicyJSONRoundTrip(f *testing.F) {
	base := validBasePolicy()
	data, err := json.Marshal(base)
	if err != nil {
		f.Fatalf("failed to marshal base policy: %v", err)
	}
	f.Add(data)

	canon, _ := base.CanonicalJSON()
	f.Add(canon)

	f.Fuzz(func(t *testing.T, input []byte) {
		var p Policy
		if err := json.Unmarshal(input, &p); err != nil {
			// Malformed JSON is rejected gracefully, not panic
			return
		}

		// Re-marshal to JSON
		out, err := json.Marshal(p)
		if err != nil {
			t.Fatalf("failed to re-marshal parsed policy: %v", err)
		}

		// Unmarshal again into secondary struct
		var p2 Policy
		if err := json.Unmarshal(out, &p2); err != nil {
			t.Fatalf("failed to unmarshal re-marshaled policy: %v", err)
		}

		// Ensure key semantic invariants hold
		if p.ID != p2.ID || p.Tenant != p2.Tenant || p.Limit != p2.Limit || p.Algorithm != p2.Algorithm {
			t.Fatalf("lossless invariant broken: %+v != %+v", p, p2)
		}

		// If policy passes validation, canonical JSON must not error
		if len(p.Validate()) == 0 {
			c1, err := p.CanonicalJSON()
			if err != nil {
				t.Fatalf("canonical json err: %v", err)
			}
			c2, err := p2.CanonicalJSON()
			if err != nil {
				t.Fatalf("canonical json err: %v", err)
			}
			if string(c1) != string(c2) {
				t.Fatalf("canonical mismatch after round-trip: %s vs %s", string(c1), string(c2))
			}
		}
	})
}
