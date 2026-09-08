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
// CONTRACT: "" is a NORMAL answer — gRPC resolution to Users may fail, and
// enriching a log line or cache key must never fail a request. Such a request is
// served from the database and cached on neither leg: an empty segment makes a
// key that LIES about its scope, and the per-user index collapses several users
// onto one entry. Never an ownership filter; ownership is cognito_sub only.
// See [[user-id-vs-cognito-sub-ownership-key]]
func ResolvedUserID(c *gin.Context) string {
	value, _ := c.Get(resolvedUserIDKey)
	userID, _ := value.(string)
	return userID
}
