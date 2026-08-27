package domain

import "testing"

func TestToolchainCompilesAndRuns(t *testing.T) {
	if Version != "tracking-go" {
		t.Fatalf("Version = %q, want %q", Version, "tracking-go")
	}
}
