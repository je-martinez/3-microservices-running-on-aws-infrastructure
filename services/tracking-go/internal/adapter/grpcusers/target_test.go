package grpcusers_test

import (
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/grpcusers"
)

// grpc-go wants a bare host:port. Orders' .NET channel REQUIRES the scheme, and
// both services read the same USERS_GRPC_URL, so both spellings must work.
func TestNormalizeTarget(t *testing.T) {
	tests := []struct{ in, want string }{
		{"users:50051", "users:50051"},
		{"http://users:50051", "users:50051"},
		{"https://users:50051", "users:50051"},
		{"http://127.0.0.1:50051", "127.0.0.1:50051"},
		{"", ""},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			if got := grpcusers.NormalizeTarget(tt.in); got != tt.want {
				t.Errorf("NormalizeTarget(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
