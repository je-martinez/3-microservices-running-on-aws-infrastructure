package grpcusers

import "strings"

// NormalizeTarget strips an http:// or https:// scheme from a gRPC target.
//
// grpc-go wants a bare host:port; a value carrying a scheme resolves to a
// nonsense authority and fails at connect time with a DNS error that names
// neither the setting nor the cause.
//
// Orders' .NET channel REQUIRES the scheme (GrpcChannel.ForAddress), so the
// shared USERS_GRPC_URL value legitimately has one. Accepting both forms here
// means the two services read the exact same environment variable instead of
// needing two spellings of one address.
func NormalizeTarget(target string) string {
	for _, scheme := range []string{"http://", "https://"} {
		if strings.HasPrefix(target, scheme) {
			return strings.TrimPrefix(target, scheme)
		}
	}
	return target
}
