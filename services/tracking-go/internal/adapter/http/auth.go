package http

import (
	"crypto/subtle"
	"log/slog"
	nethttp "net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// UserIDHeader carries the JWT `sub` the gateway injects. Despite its name it
// is NOT the internal usr_ id — see RequireCallerSub.
const UserIDHeader = "x-user-id"

// APIKeyHeader carries both key schemes. SAME NAME, DIFFERENT VALUES, DIFFERENT
// ROUTES — the two never meet on one request.
const APIKeyHeader = "x-api-key"

// callerSubKey is where RequireCallerSub stashes the verified sub.
const callerSubKey = "caller_sub"

// RequireCallerSub returns the caller's COGNITO SUB, or 401 when the gateway
// injected none.
//
// CONTRACT: The header is named x-user-id but holds the JWT sub, NOT the
// internal usr_ id tracking.user_id holds. Never pass this value where a usr_ id
// is expected — a read scoped by the wrong one silently matches nothing.
//
// CONTRACT: Treat EMPTY as missing. nginx sets x-user-id to "" for a missing or
// malformed token rather than omitting it, and accepting "" scopes a read to
// cognito_sub = "", which returns an empty result instead of a 401.
// See [[user-id-vs-cognito-sub-ownership-key]]
func RequireCallerSub() gin.HandlerFunc {
	return func(c *gin.Context) {
		sub := strings.TrimSpace(c.GetHeader(UserIDHeader))
		if sub == "" {
			c.AbortWithStatusJSON(nethttp.StatusUnauthorized, gin.H{"detail": "missing x-user-id"})
			return
		}
		c.Set(callerSubKey, sub)
		c.Next()
	}
}

// CallerSub returns the sub RequireCallerSub verified, or "" when the middleware
// did not run.
func CallerSub(c *gin.Context) string {
	sub, _ := c.Get(callerSubKey)
	value, _ := sub.(string)
	return value
}

// RequireCarrierKey validates TRACKING_CARRIER_API_KEY on the carrier webhook.
//
// WARNING: The gateway route is auth = false, so this guard is the ONLY thing in
// front of an endpoint that mutates delivery state.
//
// CONTRACT: Do NOT merge this with RequireInternalKey. The carrier key is an
// EXTERNAL credential handed to a vendor; GRPC_API_KEY is internal. Reusing one
// as the other lets an outside party authenticate against every internal
// surface, including the mass soft-delete below.
// See [[two-api-keys-two-trust-domains]]
func RequireCarrierKey(expected string, log *slog.Logger) gin.HandlerFunc {
	return apiKeyGuard(expected, log, "carrier_status_update_failed")
}

// RequireInternalKey validates GRPC_API_KEY on DELETE /v1/trackings/by-user.
//
// This is the account-deletion cascade's leg, and a mass soft-delete surface is
// the widest blast radius this service has. Accepting the CARRIER's key here
// would let an outside vendor erase a user's delivery history.
func RequireInternalKey(expected string, log *slog.Logger) gin.HandlerFunc {
	return apiKeyGuard(expected, log, "internal_delete_by_user_failed")
}

// apiKeyGuard is the shared REJECTION path, never a shared secret — each caller
// passes its own key and neither is reachable here except through the argument.
//
// CONTRACT: Answer 401, not 403. A bad key identifies no principal to forbid,
// and it keeps a wrong key indistinguishable from an absent one, so the endpoint
// reveals nothing about a key that is NEARLY right.
// See [[two-api-keys-two-trust-domains]]
func apiKeyGuard(expected string, log *slog.Logger, appEvent string) gin.HandlerFunc {
	if log == nil {
		log = slog.Default()
	}
	return func(c *gin.Context) {
		if apiKeyMatches(c.GetHeader(APIKeyHeader), expected) {
			c.Next()
			return
		}

		// Log the attempt — an unauthenticated, state-mutating endpoint is the
		// widest attack surface this service has, and failed-attempt visibility
		// is the cheapest mitigation available.
		//
		// NEVER log the key, provided or expected — not even a prefix or its
		// length.
		log.WarnContext(c.Request.Context(), appEvent,
			slog.String("app_event", appEvent),
			slog.String("reason", "invalid_api_key"),
			slog.String("client", c.ClientIP()),
		)
		c.AbortWithStatusJSON(nethttp.StatusUnauthorized, gin.H{"detail": "invalid api key"})
	}
}

// apiKeyMatches compares in CONSTANT TIME.
//
// CONTRACT: Never `==`. Go's string comparison short-circuits at the first
// differing byte, leaking the length of a guessed prefix — enough to recover a
// key byte by byte given retries. The key's LENGTH still leaks (no constant-time
// primitive hides it), its contents do not. An empty provided key returns false
// rather than erroring, so an absent header and a wrong one take one path.
// See [[two-api-keys-two-trust-domains]]
func apiKeyMatches(provided, expected string) bool {
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}
