package grpcusers

import "strings"

// NormalizeTarget strips an http:// or https:// scheme from a gRPC target.
// grpc-go wants a bare host:port, and a scheme resolves to a nonsense authority
// that fails at connect with a DNS error naming neither the setting nor the
// cause. Orders' .NET channel requires the scheme, so accepting both forms lets
// the two services read one USERS_GRPC_URL. See [[ADR-0003-grpc-inter-service]]
func NormalizeTarget(target string) string {
	for _, scheme := range []string{"http://", "https://"} {
		if strings.HasPrefix(target, scheme) {
			return strings.TrimPrefix(target, scheme)
		}
	}
	return target
}
