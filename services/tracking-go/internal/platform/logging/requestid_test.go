package logging_test

import (
	"regexp"
	"strings"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

var idShape = regexp.MustCompile(`^req_[A-Za-z0-9]{24}$`)

func TestGenerateRequestIDShape(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		id := logging.GenerateRequestID()
		if !idShape.MatchString(id) {
			t.Fatalf("GenerateRequestID() = %q, want req_ + 24 nano chars", id)
		}
		if seen[id] {
			t.Fatalf("GenerateRequestID() produced a duplicate: %q", id)
		}
		seen[id] = true
	}
}

// An inbound id is honoured only when it FULLMATCHES our shape.
func TestResolveRequestIDHonoursOurOwnFormat(t *testing.T) {
	inbound := "req_7gK3mP1vXz9wLq2bN8rRt4Yc"
	if got := logging.ResolveRequestID(inbound); got != inbound {
		t.Errorf("ResolveRequestID(%q) = %q, want the inbound id honoured", inbound, got)
	}
}

// Anything else is silently replaced with a fresh id — never a 400, and never
// the caller's value.
func TestResolveRequestIDMintsAFreshOneForAnythingElse(t *testing.T) {
	bad := []struct {
		name  string
		value string
	}{
		{"absent", ""},
		{"no prefix", "7gK3mP1vXz9wLq2bN8rRt4Yc"},
		{"wrong prefix", "trk_7gK3mP1vXz9wLq2bN8rRt4Yc"},
		{"too short", "req_7gK3mP1vXz9wLq2bN8rRt4"},
		{"too long", "req_7gK3mP1vXz9wLq2bN8rRt4Ycc"},
		{"illegal character", "req_7gK3mP1vXz9wLq2bN8rRt4Y-"},
		{"newline injection", "req_7gK3mP1vXz9wLq2bN8rRt4Yc\nfake"},
		{"prefix match only", "req_7gK3mP1vXz9wLq2bN8rRt4Yc trailing"},
		{"whitespace", "   "},
		{"control characters", "req_\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17"},
	}
	for _, tt := range bad {
		t.Run(tt.name, func(t *testing.T) {
			got := logging.ResolveRequestID(tt.value)
			if got == tt.value {
				t.Fatalf("ResolveRequestID(%q) echoed the untrusted value back", tt.value)
			}
			if !idShape.MatchString(got) {
				t.Fatalf("ResolveRequestID(%q) = %q, want a freshly minted id", tt.value, got)
			}
			if strings.ContainsAny(got, "\n\r") {
				t.Fatal("a minted id must never contain a newline")
			}
		})
	}
}
