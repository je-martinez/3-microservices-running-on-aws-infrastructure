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

// identityCache is the read-through cache in FRONT of that call, likewise
// declared by its consumer. redis.IdentityCache satisfies it.
//
// It returns a plain string with no error, and that is its whole contract: the
// cache absorbs every failure the loader can produce and answers "" for all of
// them, because this mechanism is an optimization on top of an enrichment that
// must never fail a request.
type identityCache interface {
	Resolve(ctx context.Context, cognitoSub string, loader func(context.Context) (string, error)) string
}

// StampResolvedUserID resolves the caller's internal usr_ id and records it for
// the rest of the request.
//
// # What it is FOR, and why the read paths pay for it
//
// LogContextMiddleware seeds cognito_sub for free — it is already on the
// request. user_id is not: it is a usr_ id only Users knows, so putting it on a
// read's log line costs one outbound gRPC call on a path that previously made
// none. That cost is accepted deliberately, for two returns:
//
//  1. A dashboard query joining Tracking to Orders and Users joins on user_id.
//     A service whose read lines carry only a sub cannot participate in it.
//  2. THE RESPONSE CACHE IS KEYED ON IT. Both read handlers build their key from
//     ResolvedUserID(c), and the key builders answer "not keyable" without one —
//     so with nothing calling SetResolvedUserID the response cache stores
//     nothing and serves nothing, on every request, forever. It looks
//     implemented and is inert. That is exactly what shipped, and this
//     middleware is what closes it.
//
// # Applied PER ROUTE, never globally
//
// Three of this service's surfaces have no caller identity at all and must never
// reach Users:
//
//   - PUT /v1/trackings/{order_id}/status — the carrier's, authenticated by its
//     own external API key and identified by order_id alone. Its gateway route
//     declares no Cognito authorizer, so it receives no x-user-id.
//   - DELETE /v1/trackings/by-user — the account-deletion cascade, authenticated
//     by the internal key, with its subject in the BODY.
//   - DELETE /v1/trackings/e2e-cleanup — the harness's teardown, which has no
//     session at all and selects by tag.
//
// And GET /v1/health is probed continuously by the ALB; resolving there would
// turn a liveness check into a dependency on Users being up.
//
// A GLOBAL middleware guarding on "is x-user-id present?" would work today and
// break the first time someone adds a route — and it would still fire on a STRAY
// header sent to the carrier PUT, paying a call on a request that has no
// business making one. Applying it to the routes that declare it inverts the
// default, which is the same reason RequireCallerSub is per-route rather than
// middleware-plus-an-allowlist. The Python does this with a FastAPI dependency
// (`IdentifiedCaller`); a Gin route group is the direct equivalent.
//
// # FAILURE IS NEVER FATAL — on the READ paths
//
// Users being down, slow, or holding no record for the sub all end the same way:
// nothing is stamped, nothing is merged, the read is served from MySQL and
// simply goes uncached. Enriching a log line and building a cache key are not
// worth failing a request over.
//
// CREATION IS THE OPPOSITE AND IS UNCHANGED. POST /v1/trackings/init-tracking
// resolves the id ITSELF inside its use case and answers 404 when Users has no
// record — because a tracking persisted with an empty user_id is an orphan no
// ownership predicate can ever match. This middleware having quietly failed
// first costs that path nothing: it makes its own call, and a negative is never
// cached.
//
// Returns a no-op handler when there is nothing to resolve WITH, so a process
// whose gRPC dial failed at startup still serves every read.
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
// THROUGH THE CACHE, NOT STRAIGHT TO gRPC. The identity cache exists precisely
// so a response-cache HIT does not still pay a gRPC round trip — which would
// give back most of the latency the response cache was added to remove. A nil
// cache (an unbuildable one, a runtime with caching off) degrades to the direct
// call rather than to no resolution at all: the read is still enriched and still
// keyed, it just pays the round trip.
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
// DEBUG, never WARN. On a read this is pure enrichment and an unknown caller is
// an ORDINARY outcome — a token minted for a Cognito user whose record was never
// created, or was deleted. One WARN per request during a Users blip would bury
// every real signal in the stream.
//
// It logs two OPAQUE IDENTIFIERS and a reason token, and nothing else. No email
// (not even hashed — this path has none), no address, no key, and never the
// resolved value beside anything that could pair them with a person.
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
