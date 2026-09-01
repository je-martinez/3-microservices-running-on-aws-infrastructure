package redis

import (
	"context"
	"log/slog"
)

// UserInvalidator adapts the package-level InvalidateUser to the narrow port the
// account-deletion cascade declares (app.UserCacheInvalidator).
//
// A tiny struct rather than a closure so the wiring in main.go names what it is,
// and so the gateway and logger are bound once at construction instead of being
// captured per call.
type UserInvalidator struct {
	gw  Gateway
	log *slog.Logger
}

// NewUserInvalidator binds the gateway and logger the sweep will use.
func NewUserInvalidator(gw Gateway, log *slog.Logger) *UserInvalidator {
	if log == nil {
		log = slog.Default()
	}
	return &UserInvalidator{gw: gw, log: log}
}

// InvalidateUser clears every cache entry belonging to the user — their response
// entries under both identifiers plus their cognito_sub -> user_id mapping.
//
// It returns NO error, deliberately. By the time it runs the deletion has already
// COMMITTED, so a Redis outage that could fail the caller would tell Users the
// cascade did not happen when it did, and fail the whole account deletion for the
// person. Failures are logged by the gateway and swallowed here.
func (i *UserInvalidator) InvalidateUser(ctx context.Context, cognitoSub, userID string) {
	InvalidateUser(ctx, i.gw, i.log, cognitoSub, userID)
}
