package http

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/platform/logging"
)

// The machine-readable reasons an enrichment can come up empty. They go to the
// LOG only — nothing here ever reaches a response body, because nothing here
// changes a response.
const (
	reasonUnknownUserIdentity  = "unknown_user"
	reasonUsersUnavailable     = "users_unavailable"
	reasonIdentityLookupFailed = "resolution_error"
)

// appEventUnresolved is the token a dashboard filters on to see how often
// enrichment degrades. Same spelling the Python emits, so one query spans both
// services during the migration.
const appEventUnresolved = "log_identity_unresolved"

// internalIDResolver is the ONE call this middleware makes into Users, declared
// HERE by its consumer. grpcusers.InternalIDResolver satisfies it structurally,
// so this package never imports the gRPC adapter.
type internalIDResolver interface {
	ResolveInternalUserID(ctx context.Context, cognitoSub string) (string, error)
}

// identityCache is the consumer-owned read-through cache contract.
// CONTRACT: Do NOT surface loader failures; enrichment is optional, so a cache
// failure returns "" instead of failing the request.
// See [[tracking-service-design]]
type identityCache interface {
	Resolve(ctx context.Context, cognitoSub string, loader func(context.Context) (string, error)) string
}

// StampResolvedUserID resolves the caller's internal usr_ id and records it for
// the rest of the request.
//
// CONTRACT: Do NOT install this globally or remove it from user-scoped reads.
// Global use sends carrier, delete, and health traffic to Users; omission leaves
// every read without the usr_ id required for cache keys and cross-service logs.
// Treat lookup failure as non-fatal enrichment: serve MySQL uncached. Creation
// resolves identity as a required operation and returns 404 for an unknown user.
// The x-user-id header carries cognito_sub, never the internal user_id.
// See [[tracking-service-design]]
func StampResolvedUserID(users internalIDResolver, identities identityCache, log *slog.Logger) gin.HandlerFunc {
	if log == nil {
		log = slog.Default()
	}
	return func(c *gin.Context) {
		// The header carries the caller's Cognito SUB despite its name. EMPTY IS
		// MISSING — nginx sets it to "" for an absent or malformed token — and
		// there is nothing to resolve either way, so both skip silently. The 401
		// is the route's own job; a middleware that only enriches must never
		// decide who may pass.
		cognitoSub := strings.TrimSpace(c.GetHeader(UserIDHeader))
		if cognitoSub == "" || users == nil {
			c.Next()
			return
		}

		ctx := c.Request.Context()
		userID := resolveIdentity(ctx, users, identities, cognitoSub, log)
		if userID == "" {
			// OMITTED, never merged empty: an emitted user_id="" reads as a
			// resolved identity that happened to be blank rather than "not known
			// at this point in the request". WithLogFields drops it anyway; not
			// merging is the explicit half of the same rule.
			c.Next()
			return
		}

		// BOTH halves, and both are load-bearing. The gin.Context value is what
		// the response cache's key builders read; the log context is what puts
		// user_id on the request line. Doing one without the other is how this
		// gap opened in the first place.
		SetResolvedUserID(c, userID)
		c.Request = c.Request.WithContext(
			logging.WithLogFields(ctx, slog.String(logging.KeyUserID, userID)),
		)

		c.Next()
	}
}

// resolveIdentity asks the cache first and the loader only on a miss.
//
// CONTRACT: Do NOT bypass the identity cache when present; a response-cache hit
// would still pay a Users gRPC call. A nil cache degrades to direct resolution.
// See [[tracking-service-design]]
func resolveIdentity(
	ctx context.Context,
	users internalIDResolver,
	identities identityCache,
	cognitoSub string,
	log *slog.Logger,
) string {
	loader := func(ctx context.Context) (string, error) {
		userID, err := users.ResolveInternalUserID(ctx, cognitoSub)
		if err != nil {
			logUnresolved(ctx, log, err, cognitoSub)
			// Returned as an error so the cache never stores it: a cached
			// negative would keep a real user's id out of their keys for the
			// whole hour after the cause cleared, quietly disabling the response
			// cache for that caller.
			return "", err
		}
		return userID, nil
	}

	if identities == nil {
		userID, err := loader(ctx)
		if err != nil {
			return ""
		}
		return userID
	}
	return identities.Resolve(ctx, cognitoSub, loader)
}

// logUnresolved records WHY enrichment came up empty.
//
// WARNING: Keep this at DEBUG and log only opaque identifiers plus reason.
// WARN during a Users outage floods the stream; PII would expose caller data.
func logUnresolved(ctx context.Context, log *slog.Logger, err error, cognitoSub string) {
	reason := reasonIdentityLookupFailed
	switch {
	case errors.Is(err, domain.ErrUserNotFound):
		// Users has no record for this sub. Ordinary on a read.
		reason = reasonUnknownUserIdentity
	case err != nil:
		// Unavailable, DeadlineExceeded, an unbuildable channel, anything
		// unforeseen. Deliberately NOT folded into unknown_user: an outage read
		// as "this user does not exist" is the confusion the resolver's error
		// translation exists to prevent.
		reason = reasonUsersUnavailable
	}

	log.DebugContext(ctx, appEventUnresolved,
		slog.String("app_event", appEventUnresolved),
		slog.String("reason", reason),
		slog.String("cognito_sub", cognitoSub),
	)
}
