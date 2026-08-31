package http

import "github.com/gin-gonic/gin"

// resolvedUserIDKey is where the internal usr_ id is stashed once something has
// resolved it from the caller's sub.
const resolvedUserIDKey = "resolved_user_id"

// SetResolvedUserID records the INTERNAL usr_ id for this request.
//
// Called by whatever resolves it (the identity cache in front of the Users gRPC
// client), never by a handler from the x-user-id header: that header carries the
// caller's Cognito SUB, and storing it here would put a sub where every reader
// of this value expects a usr_ id.
func SetResolvedUserID(c *gin.Context, userID string) {
	c.Set(resolvedUserIDKey, userID)
}

// ResolvedUserID returns the internal usr_ id, or "" when nothing resolved one.
//
// # "" IS A NORMAL ANSWER, NOT AN ERROR
//
// Resolution happens over gRPC to Users and is allowed to fail: enriching a log
// line or a cache key must never fail a request. So a fully authenticated caller
// can reach a handler with no user_id, and every consumer here treats that as
// "this request cannot be keyed" — it is served from the database and cached
// neither on the way in nor on the way out. Formatting an empty segment into a
// key would produce a key that LIES about what it is scoped by, and the per-user
// index built on the same empty value would collapse several users onto one
// entry.
//
// It is NEVER used as an ownership filter. Ownership is cognito_sub only.
func ResolvedUserID(c *gin.Context) string {
	value, _ := c.Get(resolvedUserIDKey)
	userID, _ := value.(string)
	return userID
}
