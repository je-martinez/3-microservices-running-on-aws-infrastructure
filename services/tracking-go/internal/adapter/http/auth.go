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
// # The header is named x-user-id but holds a Cognito SUB
//
// This is the single most misleading name on this surface. nginx sets it
// literally as `proxy_set_header x-user-id $jwt_sub` — it is the JWT's sub claim,
// NOT the internal usr_ id that tracking.user_id holds. The two are different
// strings for the same person, and a read scoped by the wrong one silently
// matches nothing. Never pass this value where an internal usr_ id is expected.
//
// # EMPTY IS MISSING
//
// nginx sets x-user-id to the EMPTY STRING when the token is missing or malformed
// rather than omitting the header, so an empty value must be treated exactly like
// an absent one. Accepting "" would scope a read to cognito_sub = ”, which
// matches no row — a silent empty result instead of the 401 the caller deserves.
//
// 401, not 403: the request carries no usable credential at all, so this is a
// failure to authenticate, not a permission denial on an identified caller.
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
// The caller is a third-party carrier, not an end user. Its gateway route is
// declared auth = false, so the request never passes a Cognito authorizer and
// carries no x-user-id: THIS SERVICE IS THE ONLY THING STANDING IN FRONT OF AN
// ENDPOINT THAT MUTATES DELIVERY STATE.
//
// # A DIFFERENT key from the internal one, deliberately
//
// TRACKING_CARRIER_API_KEY is an EXTERNAL credential handed to a vendor;
// GRPC_API_KEY is the INTERNAL service-to-service secret. Reusing one as the
// other would give an outside party a credential that authenticates as an
// internal service against every internal surface — including the mass
// soft-delete route below. This lives in its own function, beside its sibling but
// never merged with it: one function per trust domain makes the wrong-key mistake
// structurally harder than a shared helper with a key argument would.
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

// apiKeyGuard is the shared REJECTION path, never a shared secret. Both callers
// pass their own key from their own trust domain; nothing here can mix them up
// because neither key is reachable from this function except through its
// argument.
//
// # 401, not 403
//
// A missing or wrong key is answered 401. 403 would mean "we know who you are and
// you may not do this" — but a bad key identifies nobody, so there is no principal
// to forbid. It also keeps the two failure modes indistinguishable: a caller
// cannot tell a wrong key from an absent one, so the endpoint reveals nothing
// about whether a key it was given is NEARLY right.
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
// Never `==`: Go's string comparison short-circuits at the first differing byte,
// so the time it takes leaks how long a shared prefix the attacker guessed —
// enough to recover a key byte by byte given retries. subtle.ConstantTimeCompare
// takes the same time regardless.
//
// A length mismatch is not hidden by any implementation (ConstantTimeCompare
// returns 0 immediately for differing lengths, as does Node's timingSafeEqual
// guard): the key's LENGTH leaks, its CONTENTS do not. That is the same trade
// Users makes.
//
// An empty provided key returns false rather than erroring, so an absent header
// and a wrong one take the same path.
func apiKeyMatches(provided, expected string) bool {
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}
